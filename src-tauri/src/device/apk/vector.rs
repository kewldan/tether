//! Compiled drawable XML rendered to SVG: `<vector>` (paths, groups with
//! transforms, clip paths, solid and gradient fills), plus the wrappers
//! launcher icons use around it (`<inset>`, `<bitmap>`, a solid `<shape>`).
//!
//! Drawables reference other files (gradients that aapt2 extracted from
//! `<aapt:attr>`, color state lists, the bitmap inside an `<inset>`), and
//! on a device each file is a separate read. So rendering works over a
//! map of already fetched files and reports the paths it still needs;
//! callers fetch them and render again (see [`render`]).

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt::Write as _;

use super::Value;
use super::arsc::ResourceTable;
use super::axml::{self, Element};
use super::icon;

mod attr {
    pub const SRC: u32 = 0x0101_0119;
    pub const TINT: u32 = 0x0101_0121;
    pub const DRAWABLE: u32 = 0x0101_0199;
    pub const START_COLOR: u32 = 0x0101_019d;
    pub const END_COLOR: u32 = 0x0101_019e;
    pub const TYPE: u32 = 0x0101_01a1;
    pub const CENTER_X: u32 = 0x0101_01a2;
    pub const CENTER_Y: u32 = 0x0101_01a3;
    pub const GRADIENT_RADIUS: u32 = 0x0101_01a4;
    pub const COLOR: u32 = 0x0101_01a5;
    pub const LEFT: u32 = 0x0101_01ad;
    pub const TOP: u32 = 0x0101_01ae;
    pub const RIGHT: u32 = 0x0101_01af;
    pub const BOTTOM: u32 = 0x0101_01b0;
    pub const PIVOT_X: u32 = 0x0101_01b5;
    pub const PIVOT_Y: u32 = 0x0101_01b6;
    pub const INSET_LEFT: u32 = 0x0101_01b7;
    pub const INSET_RIGHT: u32 = 0x0101_01b8;
    pub const INSET_TOP: u32 = 0x0101_01b9;
    pub const INSET_BOTTOM: u32 = 0x0101_01ba;
    pub const TILE_MODE: u32 = 0x0101_0201;
    pub const CENTER_COLOR: u32 = 0x0101_020b;
    pub const ALPHA: u32 = 0x0101_031f;
    pub const SCALE_X: u32 = 0x0101_0324;
    pub const SCALE_Y: u32 = 0x0101_0325;
    pub const ROTATION: u32 = 0x0101_0326;
    pub const VIEWPORT_WIDTH: u32 = 0x0101_0402;
    pub const VIEWPORT_HEIGHT: u32 = 0x0101_0403;
    pub const FILL_COLOR: u32 = 0x0101_0404;
    pub const PATH_DATA: u32 = 0x0101_0405;
    pub const STROKE_COLOR: u32 = 0x0101_0406;
    pub const STROKE_WIDTH: u32 = 0x0101_0407;
    pub const STROKE_LINE_CAP: u32 = 0x0101_040b;
    pub const STROKE_LINE_JOIN: u32 = 0x0101_040c;
    pub const STROKE_MITER_LIMIT: u32 = 0x0101_040d;
    pub const TRANSLATE_X: u32 = 0x0101_045a;
    pub const TRANSLATE_Y: u32 = 0x0101_045b;
    pub const INSET: u32 = 0x0101_04b5;
    pub const STROKE_ALPHA: u32 = 0x0101_04cb;
    pub const FILL_ALPHA: u32 = 0x0101_04cc;
    pub const START_X: u32 = 0x0101_0510;
    pub const START_Y: u32 = 0x0101_0511;
    pub const END_X: u32 = 0x0101_0512;
    pub const END_Y: u32 = 0x0101_0513;
    pub const OFFSET: u32 = 0x0101_0514;
    pub const FILL_TYPE: u32 = 0x0101_051e;
}

const TYPE_DIMENSION: u8 = 0x05;
const TYPE_FRACTION: u8 = 0x06;
/// Adaptive icon layers are 108 × 108 dp.
const LAYER_DP: f32 = 108.0;
const MAX_DEPTH: u8 = 4;

/// Fetched files: `Some(bytes)`, or `None` when reading failed.
pub type Files = HashMap<String, Option<Vec<u8>>>;

/// What a drawable layer renders to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rendered {
    /// A data URL (SVG or bitmap) or a CSS color.
    Done(String),
    /// These files are needed first.
    Need(Vec<String>),
    /// Not something we can draw.
    Unsupported,
}

struct Ctx<'t, 'a> {
    table: &'t ResourceTable<'a>,
    files: &'t Files,
    need: RefCell<Vec<String>>,
    next_id: RefCell<u32>,
}

impl Ctx<'_, '_> {
    fn file(&self, path: &str) -> Option<&[u8]> {
        match self.files.get(path) {
            Some(Some(data)) => Some(data),
            Some(None) => None,
            None => {
                let mut need = self.need.borrow_mut();
                if !need.iter().any(|p| p == path) {
                    need.push(path.to_owned());
                }
                None
            }
        }
    }

    fn id(&self, prefix: &str) -> String {
        let mut n = self.next_id.borrow_mut();
        *n += 1;
        format!("{prefix}{n}")
    }

    /// Follows references to a concrete value (color or file path).
    fn resolve(&self, value: &Value, depth: u8) -> Option<Value> {
        match value {
            Value::Reference(id) if depth < MAX_DEPTH => {
                if let Some(c) = framework_color(*id) {
                    return Some(Value::Color(c));
                }
                let values = self.table.values(*id);
                // Files: the sharpest bitmap, else the newest XML.
                let files: Vec<_> = values
                    .iter()
                    .filter_map(|(c, v)| Some((c.clone(), v.as_str()?.to_owned())))
                    .collect();
                if let Some(path) = icon::best_file(&files) {
                    return Some(Value::String(path));
                }
                // Values: the default configuration (no night/locale).
                let (_, v) = values
                    .iter()
                    .find(|(c, _)| c.language.is_empty())
                    .or(values.first())?;
                self.resolve(v, depth + 1)
            }
            Value::Reference(_) | Value::Attribute(_) => None,
            other => Some(other.clone()),
        }
    }
}

/// `@android:color/…` values apps commonly use in icons.
pub(crate) fn framework_color(id: u32) -> Option<u32> {
    match id {
        0x0106_0000 => Some(0x0000_0000), // transparent
        0x0106_000b => Some(0xffff_ffff), // white
        0x0106_000c => Some(0xff00_0000), // black
        _ => None,
    }
}

/// Renders the drawable XML at `path` (or a bitmap file) to a data URL.
pub fn render(table: &ResourceTable<'_>, path: &str, files: &Files) -> Rendered {
    run(table, files, |ctx| drawable_file(ctx, path, 0))
}

/// Renders a drawable written inline, e.g. `<foreground><inset …/>`.
pub fn render_element(table: &ResourceTable<'_>, element: &Element, files: &Files) -> Rendered {
    run(table, files, |ctx| drawable_element(ctx, element, 0))
}

fn run(
    table: &ResourceTable<'_>,
    files: &Files,
    draw: impl FnOnce(&Ctx<'_, '_>) -> Option<Content>,
) -> Rendered {
    let ctx = Ctx {
        table,
        files,
        need: RefCell::new(Vec::new()),
        next_id: RefCell::new(0),
    };
    let out = draw(&ctx);
    let need = ctx.need.into_inner();
    match out {
        _ if !need.is_empty() => Rendered::Need(need),
        Some(Content::Color(c)) => Rendered::Done(icon::css_color(c)),
        Some(Content::Image(url)) => Rendered::Done(url),
        Some(Content::Svg(svg)) => Rendered::Done(svg_url(&svg)),
        None => Rendered::Unsupported,
    }
}

pub fn svg_url(svg: &str) -> String {
    format!("data:image/svg+xml;base64,{}", icon::base64(svg.as_bytes()))
}

enum Content {
    Color(u32),
    /// Bitmap data URL.
    Image(String),
    /// A standalone `<svg>` document.
    Svg(String),
}

fn drawable_file(ctx: &Ctx<'_, '_>, path: &str, depth: u8) -> Option<Content> {
    if depth > MAX_DEPTH {
        return None;
    }
    let data = ctx.file(path)?;
    if !path.ends_with(".xml") {
        return Some(Content::Image(icon::data_url(path, data)));
    }
    drawable_element(ctx, &axml::parse(data)?, depth)
}

fn drawable_element(ctx: &Ctx<'_, '_>, root: &Element, depth: u8) -> Option<Content> {
    if depth > MAX_DEPTH {
        return None;
    }
    match root.name.as_str() {
        "vector" => vector(ctx, root).map(Content::Svg),
        "inset" => inset(ctx, root, depth),
        "layer-list" => layer_list(ctx, root, depth),
        "bitmap" => {
            let src = ctx.resolve(attr_of(root, attr::SRC, "src")?, 0)?;
            drawable_value(ctx, &src, depth + 1)
        }
        "shape" => root
            .child("solid")
            .and_then(|s| color(ctx, attr_of(s, attr::COLOR, "color")?, 0))
            .map(Content::Color),
        "color" => color(ctx, attr_of(root, attr::COLOR, "color")?, 0).map(Content::Color),
        _ => None,
    }
}

fn drawable_value(ctx: &Ctx<'_, '_>, value: &Value, depth: u8) -> Option<Content> {
    match ctx.resolve(value, 0)? {
        Value::Color(c) => Some(Content::Color(c)),
        Value::String(path) => drawable_file(ctx, &path, depth),
        _ => None,
    }
}

/// The drawable of a wrapper: its `android:drawable`, or its first child
/// element when written inline.
fn inner_drawable(ctx: &Ctx<'_, '_>, el: &Element, depth: u8) -> Option<Content> {
    match attr_of(el, attr::DRAWABLE, "drawable") {
        Some(value) => drawable_value(ctx, value, depth + 1),
        None => drawable_element(ctx, el.children.first()?, depth + 1),
    }
}

/// `content` drawn into the box `[left, top, w, h]` of the 108 dp layer.
fn placed(content: Content, left: f32, top: f32, w: f32, h: f32) -> Option<String> {
    let (x, y, w, h) = (num(left), num(top), num(w), num(h));
    Some(match content {
        Content::Color(c) => format!(
            r#"<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{}"/>"#,
            icon::css_color(c)
        ),
        Content::Image(url) => format!(
            r#"<image x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="none" href="{url}"/>"#
        ),
        // Nest the document as a positioned <svg> element.
        Content::Svg(svg) => format!(
            r#"<svg x="{x}" y="{y}" width="{w}" height="{h}" {}"#,
            svg.strip_prefix("<svg ")?
        ),
    })
}

fn layer_svg(body: &str) -> Content {
    Content::Svg(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">{body}</svg>"#
    ))
}

/// A `<layer-list>`: items stacked bottom to top, each with its insets.
fn layer_list(ctx: &Ctx<'_, '_>, root: &Element, depth: u8) -> Option<Content> {
    let mut body = String::new();
    for item in root.children_named("item") {
        let Some(content) = inner_drawable(ctx, item, depth) else {
            continue;
        };
        let side = |id, name| attr_of(item, id, name).and_then(length).unwrap_or(0.0);
        let (l, t) = (side(attr::LEFT, "left"), side(attr::TOP, "top"));
        let (r, b) = (side(attr::RIGHT, "right"), side(attr::BOTTOM, "bottom"));
        body.push_str(&placed(
            content,
            l,
            t,
            (LAYER_DP - l - r).max(0.0),
            (LAYER_DP - t - b).max(0.0),
        )?);
    }
    (!body.is_empty()).then(|| layer_svg(&body))
}

/// An `<inset>`: the inner drawable drawn into a smaller box of the
/// 108 dp layer.
fn inset(ctx: &Ctx<'_, '_>, root: &Element, depth: u8) -> Option<Content> {
    let inner = inner_drawable(ctx, root, depth)?;
    let all = attr_of(root, attr::INSET, "inset").and_then(length);
    let side = |id, name| {
        attr_of(root, id, name)
            .and_then(length)
            .or(all)
            .unwrap_or(0.0)
    };
    let left = side(attr::INSET_LEFT, "insetLeft");
    let top = side(attr::INSET_TOP, "insetTop");
    let right = side(attr::INSET_RIGHT, "insetRight");
    let bottom = side(attr::INSET_BOTTOM, "insetBottom");
    let w = (LAYER_DP - left - right).max(0.0);
    let h = (LAYER_DP - top - bottom).max(0.0);
    Some(layer_svg(&placed(inner, left, top, w, h)?))
}

/// An inset length in dp of the 108 dp layer: a dimension or a fraction.
fn length(value: &Value) -> Option<f32> {
    match value {
        Value::Other { kind, data } if *kind == TYPE_DIMENSION => Some(complex(*data)),
        Value::Other { kind, data } if *kind == TYPE_FRACTION => Some(complex(*data) * LAYER_DP),
        Value::Float(f) => Some(*f),
        Value::Int(i) => Some(*i as f32),
        _ => None,
    }
}

/// `Res_value` complex number (dimension / fraction) without its unit.
fn complex(data: u32) -> f32 {
    const RADIX: [f32; 4] = [
        1.0 / 256.0,
        1.0 / 32_768.0,
        1.0 / 8_388_608.0,
        1.0 / 2_147_483_648.0,
    ];
    let mantissa = (data & 0xffff_ff00) as i32 as f32;
    mantissa * RADIX[((data >> 4) & 3) as usize]
}

fn attr_of<'e>(el: &'e Element, id: u32, name: &str) -> Option<&'e Value> {
    el.attr(id, name).or_else(|| {
        el.attrs
            .iter()
            .find(|a| a.name == name && a.namespace.as_deref() == Some(axml::ANDROID_NS))
            .map(|a| &a.value)
    })
}

fn float(el: &Element, id: u32, name: &str) -> Option<f32> {
    match attr_of(el, id, name)? {
        Value::Float(f) => Some(*f),
        Value::Int(i) => Some(*i as f32),
        Value::Other { kind, data } if *kind == TYPE_DIMENSION || *kind == TYPE_FRACTION => {
            Some(complex(*data))
        }
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn int(el: &Element, id: u32, name: &str) -> Option<u32> {
    attr_of(el, id, name).and_then(Value::as_int)
}

fn num(v: f32) -> String {
    let rounded = (v * 10_000.0).round() / 10_000.0;
    format!("{rounded}")
}

/// Escapes text for an XML attribute.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// A color attribute: literal, `@color/…`, or a color state list file
/// (its default item).
fn color(ctx: &Ctx<'_, '_>, value: &Value, depth: u8) -> Option<u32> {
    match ctx.resolve(value, 0)? {
        Value::Color(c) => Some(c),
        Value::String(path) if depth < MAX_DEPTH && path.ends_with(".xml") => {
            let root = axml::parse(ctx.file(&path)?)?;
            if root.name != "selector" {
                return None;
            }
            // The first item without state qualifiers, else the last one.
            let item = root
                .children_named("item")
                .find(|i| !i.attrs.iter().any(|a| a.name.starts_with("state_")))
                .or_else(|| root.children_named("item").last())?;
            let c = color(ctx, attr_of(item, attr::COLOR, "color")?, depth + 1)?;
            Some(match float(item, attr::ALPHA, "alpha") {
                Some(alpha) => with_alpha(c, alpha),
                None => c,
            })
        }
        _ => None,
    }
}

fn with_alpha(argb: u32, alpha: f32) -> u32 {
    let a = ((argb >> 24) as f32 * alpha.clamp(0.0, 1.0)).round() as u32;
    (a << 24) | (argb & 0x00ff_ffff)
}

/// A fill or stroke: solid color, or a gradient written into `defs`.
fn paint(ctx: &Ctx<'_, '_>, value: &Value, defs: &mut String) -> Option<String> {
    if let Some(Value::String(path)) = ctx.resolve(value, 0)
        && path.ends_with(".xml")
        && let Some(root) = ctx.file(&path).and_then(axml::parse)
        && root.name == "gradient"
    {
        return gradient(ctx, &root, defs);
    }
    color(ctx, value, 0).map(icon::css_color)
}

fn gradient(ctx: &Ctx<'_, '_>, g: &Element, defs: &mut String) -> Option<String> {
    let mut stops: Vec<(f32, u32)> = g
        .children_named("item")
        .filter_map(|item| {
            let offset = float(item, attr::OFFSET, "offset")?;
            let c = color(ctx, attr_of(item, attr::COLOR, "color")?, 0)?;
            Some((offset, c))
        })
        .collect();
    if stops.is_empty() {
        let c = |id, name| attr_of(g, id, name).and_then(|v| color(ctx, v, 0));
        let start = c(attr::START_COLOR, "startColor")?;
        let end = c(attr::END_COLOR, "endColor")?;
        stops.push((0.0, start));
        if let Some(center) = c(attr::CENTER_COLOR, "centerColor") {
            stops.push((0.5, center));
        }
        stops.push((1.0, end));
    }
    let f = |id, name| float(g, id, name).unwrap_or(0.0);
    let spread = match int(g, attr::TILE_MODE, "tileMode") {
        Some(1) => r#" spreadMethod="repeat""#,
        Some(2) => r#" spreadMethod="reflect""#,
        _ => "",
    };
    let id = ctx.id("g");
    let (tag, geometry) = match int(g, attr::TYPE, "type").unwrap_or(0) {
        0 => (
            "linearGradient",
            format!(
                r#"x1="{}" y1="{}" x2="{}" y2="{}""#,
                num(f(attr::START_X, "startX")),
                num(f(attr::START_Y, "startY")),
                num(f(attr::END_X, "endX")),
                num(f(attr::END_Y, "endY"))
            ),
        ),
        1 => (
            "radialGradient",
            format!(
                r#"cx="{}" cy="{}" r="{}""#,
                num(f(attr::CENTER_X, "centerX")),
                num(f(attr::CENTER_Y, "centerY")),
                num(f(attr::GRADIENT_RADIUS, "gradientRadius"))
            ),
        ),
        // Sweep gradients have no SVG equivalent: use the middle color.
        _ => return Some(icon::css_color(stops[stops.len() / 2].1)),
    };
    let _ = write!(
        defs,
        r#"<{tag} id="{id}" gradientUnits="userSpaceOnUse" {geometry}{spread}>"#
    );
    for (offset, c) in stops {
        let _ = write!(
            defs,
            r#"<stop offset="{}" stop-color="{}"/>"#,
            num(offset),
            icon::css_color(c)
        );
    }
    let _ = write!(defs, "</{tag}>");
    Some(format!("url(#{id})"))
}

/// A `<vector>` element as a standalone SVG document.
fn vector(ctx: &Ctx<'_, '_>, root: &Element) -> Option<String> {
    let vw = float(root, attr::VIEWPORT_WIDTH, "viewportWidth").filter(|v| *v > 0.0)?;
    let vh = float(root, attr::VIEWPORT_HEIGHT, "viewportHeight").filter(|v| *v > 0.0)?;
    let mut defs = String::new();
    let mut body = String::new();
    children(ctx, root, &mut body, &mut defs);

    let mut wrap_open = String::new();
    if let Some(alpha) = float(root, attr::ALPHA, "alpha").filter(|a| *a < 1.0) {
        let _ = write!(wrap_open, r#"<g opacity="{}">"#, num(alpha));
    }
    // android:tint with the default SRC_IN mode recolors every pixel.
    if let Some(tint) = attr_of(root, attr::TINT, "tint").and_then(|v| color(ctx, v, 0)) {
        let id = ctx.id("t");
        let _ = write!(
            defs,
            r#"<filter id="{id}"><feFlood flood-color="{}"/><feComposite in2="SourceGraphic" operator="in"/></filter>"#,
            icon::css_color(tint)
        );
        let _ = write!(wrap_open, r#"<g filter="url(#{id})">"#);
    }
    let closes = wrap_open.matches("<g").count();
    let mut svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {} {}" preserveAspectRatio="none">"#,
        num(vw),
        num(vh)
    );
    if !defs.is_empty() {
        let _ = write!(svg, "<defs>{defs}</defs>");
    }
    svg.push_str(&wrap_open);
    svg.push_str(&body);
    svg.push_str(&"</g>".repeat(closes));
    svg.push_str("</svg>");
    Some(svg)
}

/// Children of a `<vector>` or `<group>`. A `<clip-path>` clips the
/// siblings that follow it.
fn children(ctx: &Ctx<'_, '_>, parent: &Element, out: &mut String, defs: &mut String) {
    let mut open_clips = 0;
    for child in &parent.children {
        match child.name.as_str() {
            "path" => path(ctx, child, out, defs),
            "group" => group(ctx, child, out, defs),
            "clip-path" => {
                let Some(d) = attr_of(child, attr::PATH_DATA, "pathData").and_then(Value::as_str)
                else {
                    continue;
                };
                let id = ctx.id("c");
                let _ = write!(
                    defs,
                    r#"<clipPath id="{id}"><path d="{}"/></clipPath>"#,
                    esc(d)
                );
                let _ = write!(out, r#"<g clip-path="url(#{id})">"#);
                open_clips += 1;
            }
            _ => {}
        }
    }
    out.push_str(&"</g>".repeat(open_clips));
}

fn group(ctx: &Ctx<'_, '_>, g: &Element, out: &mut String, defs: &mut String) {
    let f = |id, name, default| float(g, id, name).unwrap_or(default);
    let (px, py) = (
        f(attr::PIVOT_X, "pivotX", 0.0),
        f(attr::PIVOT_Y, "pivotY", 0.0),
    );
    let (tx, ty) = (
        f(attr::TRANSLATE_X, "translateX", 0.0),
        f(attr::TRANSLATE_Y, "translateY", 0.0),
    );
    let (sx, sy) = (
        f(attr::SCALE_X, "scaleX", 1.0),
        f(attr::SCALE_Y, "scaleY", 1.0),
    );
    let rotation = f(attr::ROTATION, "rotation", 0.0);
    // Android: translate(-pivot), scale, rotate, translate(pivot + t).
    let mut transform = Vec::new();
    if px + tx != 0.0 || py + ty != 0.0 {
        transform.push(format!("translate({} {})", num(px + tx), num(py + ty)));
    }
    if rotation != 0.0 {
        transform.push(format!("rotate({})", num(rotation)));
    }
    if sx != 1.0 || sy != 1.0 {
        transform.push(format!("scale({} {})", num(sx), num(sy)));
    }
    if px != 0.0 || py != 0.0 {
        transform.push(format!("translate({} {})", num(-px), num(-py)));
    }
    if transform.is_empty() {
        out.push_str("<g>");
    } else {
        let _ = write!(out, r#"<g transform="{}">"#, transform.join(" "));
    }
    children(ctx, g, out, defs);
    out.push_str("</g>");
}

fn path(ctx: &Ctx<'_, '_>, p: &Element, out: &mut String, defs: &mut String) {
    let Some(d) = attr_of(p, attr::PATH_DATA, "pathData").and_then(Value::as_str) else {
        return;
    };
    let fill = attr_of(p, attr::FILL_COLOR, "fillColor").and_then(|v| paint(ctx, v, defs));
    let stroke = attr_of(p, attr::STROKE_COLOR, "strokeColor").and_then(|v| paint(ctx, v, defs));
    let stroke_width = float(p, attr::STROKE_WIDTH, "strokeWidth").unwrap_or(0.0);
    let stroke = stroke.filter(|_| stroke_width > 0.0);
    if fill.is_none() && stroke.is_none() {
        return;
    }
    let _ = write!(
        out,
        r#"<path d="{}" fill="{}""#,
        esc(d),
        fill.as_deref().unwrap_or("none")
    );
    if let Some(a) = float(p, attr::FILL_ALPHA, "fillAlpha").filter(|a| *a < 1.0) {
        let _ = write!(out, r#" fill-opacity="{}""#, num(a));
    }
    if int(p, attr::FILL_TYPE, "fillType") == Some(1) {
        out.push_str(r#" fill-rule="evenodd""#);
    }
    if let Some(stroke) = stroke {
        let _ = write!(
            out,
            r#" stroke="{stroke}" stroke-width="{}""#,
            num(stroke_width)
        );
        if let Some(a) = float(p, attr::STROKE_ALPHA, "strokeAlpha").filter(|a| *a < 1.0) {
            let _ = write!(out, r#" stroke-opacity="{}""#, num(a));
        }
        match int(p, attr::STROKE_LINE_CAP, "strokeLineCap") {
            Some(1) => out.push_str(r#" stroke-linecap="round""#),
            Some(2) => out.push_str(r#" stroke-linecap="square""#),
            _ => {}
        }
        match int(p, attr::STROKE_LINE_JOIN, "strokeLineJoin") {
            Some(1) => out.push_str(r#" stroke-linejoin="round""#),
            Some(2) => out.push_str(r#" stroke-linejoin="bevel""#),
            _ => {}
        }
        if let Some(m) = float(p, attr::STROKE_MITER_LIMIT, "strokeMiterLimit") {
            let _ = write!(out, r#" stroke-miterlimit="{}""#, num(m));
        }
    }
    out.push_str("/>");
}

#[cfg(test)]
mod tests {
    use super::super::fixtures;
    use super::*;

    fn render_all(table: &ResourceTable<'_>, apk: &[u8], path: &str) -> Rendered {
        let mut files = Files::new();
        for _ in 0..5 {
            match render(table, path, &files) {
                Rendered::Need(paths) => {
                    for p in paths {
                        let data = std::panic::catch_unwind(|| fixtures::zip_entry(apk, &p)).ok();
                        files.insert(p, data);
                    }
                }
                done => return done,
            }
        }
        panic!("did not converge");
    }

    fn svg_of(url: &str) -> String {
        use base64::Engine;
        let b64 = url.strip_prefix("data:image/svg+xml;base64,").unwrap();
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn decodes_complex_dimensions() {
        // 18dp (radix 23p0, unit dip) and 50% (radix 0p23, unit fraction).
        assert_eq!(complex(0x0000_1201), 18.0);
        assert_eq!(complex(0x4000_0030), 0.5);
        assert_eq!(complex(0xffff_ee01), -18.0);
    }

    #[test]
    fn asks_for_missing_files_then_renders() {
        let arsc = fixtures::zip_entry(fixtures::VECTOR_APK, "resources.arsc");
        let table = ResourceTable::parse(&arsc).unwrap();
        let path = "res/drawable/ic_launcher_foreground.xml";
        assert_eq!(
            render(&table, path, &Files::new()),
            Rendered::Need(vec![path.to_owned()])
        );
        let Rendered::Done(url) = render_all(&table, fixtures::VECTOR_APK, path) else {
            panic!("not rendered");
        };
        let svg = svg_of(&url);
        assert!(
            svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108""#)
        );
        // Literal fill, @color reference, gradient from <aapt:attr>, a
        // stroked path and a transformed group with a clip path.
        assert!(svg.contains(r##"fill="#3ddc84ff""##), "{svg}");
        assert!(svg.contains(r##"fill="#073042ff""##), "{svg}");
        assert!(svg.contains("<linearGradient"), "{svg}");
        assert!(svg.contains(r#"fill="url(#g"#), "{svg}");
        assert!(svg.contains(r#"stroke-linecap="round""#), "{svg}");
        assert!(
            svg.contains("translate(54 54) rotate(45) scale(0.5 0.5) translate(-54 -54)"),
            "{svg}"
        );
        assert!(svg.contains("<clipPath"), "{svg}");
        assert!(svg.contains(r#"fill-rule="evenodd""#), "{svg}");
    }

    #[test]
    fn renders_inset_and_shape_layers() {
        let arsc = fixtures::zip_entry(fixtures::VECTOR_APK, "resources.arsc");
        let table = ResourceTable::parse(&arsc).unwrap();
        let Rendered::Done(url) = render_all(
            &table,
            fixtures::VECTOR_APK,
            "res/drawable/ic_inset_foreground.xml",
        ) else {
            panic!("not rendered");
        };
        let svg = svg_of(&url);
        assert!(
            svg.contains(r#"viewBox="0 0 108 108"><svg x="18" y="18" width="72" height="72""#),
            "{svg}"
        );
        assert_eq!(
            render_all(
                &table,
                fixtures::VECTOR_APK,
                "res/drawable/ic_launcher_background.xml"
            ),
            Rendered::Done("#ffffffff".into())
        );
    }

    #[test]
    fn renders_real_launcher_background_grid() {
        // Android Studio's `ic_launcher_background.xml` as shipped in an
        // app on the emulator (resource names obfuscated by R8).
        let arsc = fixtures::zip_entry(fixtures::PLAIN_APK, "resources.arsc");
        let table = ResourceTable::parse(&arsc).unwrap();
        let mut files = Files::new();
        files.insert(
            "res/0w.xml".into(),
            Some(fixtures::LAUNCHER_BACKGROUND.to_vec()),
        );
        let Rendered::Done(url) = render(&table, "res/0w.xml", &files) else {
            panic!("not rendered");
        };
        let svg = svg_of(&url);
        assert_eq!(svg.matches("<path ").count(), 33);
        assert!(
            svg.contains(r##"<path d="M0,0h108v108h-108z" fill="#3ddc84ff"/>"##),
            "{svg}"
        );
        assert_eq!(
            svg.matches(r##"stroke="#ffffff33" stroke-width="0.8""##)
                .count(),
            32
        );
    }

    #[test]
    fn renders_inline_layer_list() {
        let arsc = fixtures::zip_entry(fixtures::VECTOR_APK, "resources.arsc");
        let table = ResourceTable::parse(&arsc).unwrap();
        let glyph = fixtures::zip_entry(fixtures::VECTOR_APK, "res/drawable/ic_glyph.xml");
        let item = |drawable: Option<Value>, attrs: Vec<(u32, &str, Value)>| Element {
            name: "item".into(),
            attrs: drawable
                .map(|v| ("drawable", attr::DRAWABLE, v))
                .into_iter()
                .map(|(n, id, v)| (id, n, v))
                .chain(attrs)
                .map(|(id, n, v)| axml::Attr {
                    namespace: Some(axml::ANDROID_NS.into()),
                    name: n.into(),
                    res_id: Some(id),
                    value: v,
                })
                .collect(),
            children: Vec::new(),
        };
        let list = Element {
            name: "layer-list".into(),
            attrs: Vec::new(),
            children: vec![
                item(Some(Value::Color(0xff00_ff00)), Vec::new()),
                item(
                    Some(Value::String("res/drawable/ic_glyph.xml".into())),
                    vec![(attr::LEFT, "left", Value::Float(8.0))],
                ),
            ],
        };
        let mut files = Files::new();
        assert_eq!(
            render_element(&table, &list, &files),
            Rendered::Need(vec!["res/drawable/ic_glyph.xml".into()])
        );
        files.insert("res/drawable/ic_glyph.xml".into(), Some(glyph));
        let Rendered::Done(url) = render_element(&table, &list, &files) else {
            panic!("not rendered");
        };
        let svg = svg_of(&url);
        assert!(
            svg.contains(r##"<rect x="0" y="0" width="108" height="108" fill="#00ff00ff"/>"##),
            "{svg}"
        );
        assert!(
            svg.contains(r#"<svg x="8" y="0" width="100" height="108" xmlns"#),
            "{svg}"
        );
        // The glyph's android:tint (@color/accent) becomes a flood filter.
        assert!(
            svg.contains(r##"<feFlood flood-color="#ea4335ff"/>"##),
            "{svg}"
        );
    }

    #[test]
    fn refuses_non_drawables() {
        let arsc = fixtures::zip_entry(fixtures::VECTOR_APK, "resources.arsc");
        let table = ResourceTable::parse(&arsc).unwrap();
        let mut files = Files::new();
        files.insert("res/x.xml".into(), Some(b"garbage".to_vec()));
        files.insert("res/y.xml".into(), None);
        assert_eq!(render(&table, "res/x.xml", &files), Rendered::Unsupported);
        assert_eq!(render(&table, "res/y.xml", &files), Rendered::Unsupported);
    }
}
