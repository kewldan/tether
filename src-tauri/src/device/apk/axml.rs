//! Android binary XML (`RES_XML_TYPE`, 0x0003) parsed into a small tree.

use super::strings::{CHUNK_STRING_POOL, StringPool};
use super::{Chunk, Le, Value, chunks};

const CHUNK_XML: u16 = 0x0003;
const CHUNK_RESOURCE_MAP: u16 = 0x0180;
const CHUNK_START_ELEMENT: u16 = 0x0102;
const CHUNK_END_ELEMENT: u16 = 0x0103;

pub const ANDROID_NS: &str = "http://schemas.android.com/apk/res/android";

#[derive(Debug, Clone, PartialEq)]
pub struct Attr {
    pub namespace: Option<String>,
    pub name: String,
    /// Resource id of the attribute (`android:label` = 0x01010001). Survives
    /// obfuscators that strip attribute names.
    pub res_id: Option<u32>,
    pub value: Value,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Element {
    pub name: String,
    pub attrs: Vec<Attr>,
    pub children: Vec<Element>,
}

impl Element {
    /// Attribute by framework resource id, falling back to the `android:`
    /// name for documents without a resource map.
    pub fn attr(&self, res_id: u32, name: &str) -> Option<&Value> {
        self.attrs
            .iter()
            .find(|a| a.res_id == Some(res_id))
            .or_else(|| {
                self.attrs.iter().find(|a| {
                    a.res_id.is_none()
                        && a.name == name
                        && a.namespace.as_deref().is_none_or(|ns| ns == ANDROID_NS)
                })
            })
            .map(|a| &a.value)
    }

    /// Attribute without namespace, e.g. `package` on `<manifest>`.
    pub fn plain_attr(&self, name: &str) -> Option<&Value> {
        self.attrs
            .iter()
            .find(|a| a.name == name && a.namespace.is_none())
            .map(|a| &a.value)
    }

    pub fn children_named<'s>(&'s self, name: &'s str) -> impl Iterator<Item = &'s Element> {
        self.children.iter().filter(move |c| c.name == name)
    }

    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.name == name)
    }
}

/// Parses a binary XML document and returns its root element.
pub fn parse(data: &[u8]) -> Option<Element> {
    let header = Chunk::read(data, 0)?;
    if header.kind != CHUNK_XML {
        return None;
    }

    let mut pool = StringPool::empty();
    let mut res_map: &[u8] = &[];
    // Elements still open; the bottom one is a synthetic document node.
    let mut stack: Vec<Element> = vec![Element::default()];

    for (at, chunk) in chunks(data, header.header_size, header.size) {
        match chunk.kind {
            CHUNK_STRING_POOL => pool = StringPool::parse(data, at)?,
            CHUNK_RESOURCE_MAP => {
                res_map = &data[at + chunk.header_size..at + chunk.size];
            }
            CHUNK_START_ELEMENT => {
                let element = start_element(data, at, chunk, &pool, res_map)?;
                stack.push(element);
            }
            CHUNK_END_ELEMENT if stack.len() > 1 => {
                let done = stack.pop()?;
                stack.last_mut()?.children.push(done);
            }
            _ => {}
        }
    }

    // Unclosed elements (truncated file): fold them into their parents.
    while stack.len() > 1 {
        let done = stack.pop()?;
        stack.last_mut()?.children.push(done);
    }
    stack.pop()?.children.into_iter().next()
}

fn start_element(
    data: &[u8],
    at: usize,
    chunk: Chunk,
    pool: &StringPool<'_>,
    res_map: &[u8],
) -> Option<Element> {
    let ext = at + chunk.header_size;
    let name = pool.get(data.u32_at(ext + 4)?).unwrap_or_default();
    let attr_start = data.u16_at(ext + 8)? as usize;
    let attr_size = data.u16_at(ext + 10)? as usize;
    let attr_count = data.u16_at(ext + 12)? as usize;
    if attr_size < 20 {
        return None;
    }

    let string = |index: u32| (index != u32::MAX).then(|| pool.get(index)).flatten();
    let mut attrs = Vec::with_capacity(attr_count);
    for i in 0..attr_count {
        let a = ext + attr_start + i * attr_size;
        if a + 20 > at + chunk.size {
            break;
        }
        let ns = string(data.u32_at(a)?);
        let name_index = data.u32_at(a + 4)?;
        let raw = data.u32_at(a + 8)?;
        let kind = data.u8_at(a + 15)?;
        let value_data = data.u32_at(a + 16)?;
        let res_id = res_map
            .u32_at(name_index as usize * 4)
            .filter(|&id| id != 0);
        let value = Value::from_raw(kind, value_data, |i| string(i).or_else(|| string(raw)));
        attrs.push(Attr {
            namespace: ns.filter(|s| !s.is_empty()),
            name: string(name_index).unwrap_or_default(),
            res_id,
            value,
        });
    }

    Some(Element {
        name,
        attrs,
        children: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::fixtures;
    use super::*;

    #[test]
    fn parses_aapt2_manifest_tree() {
        let xml = fixtures::zip_entry(fixtures::PLAIN_APK, "AndroidManifest.xml");
        let root = parse(&xml).unwrap();
        assert_eq!(root.name, "manifest");
        assert_eq!(
            root.plain_attr("package").and_then(Value::as_str),
            Some("dev.tether.fixture")
        );
        // android:versionCode = 0x0101021b
        assert_eq!(
            root.attr(0x0101_021b, "versionCode"),
            Some(&Value::Int(2150))
        );
        let app = root.child("application").unwrap();
        assert!(
            matches!(app.attr(0x0101_0001, "label"), Some(Value::Reference(id)) if id >> 24 == 0x7f)
        );
        assert_eq!(app.children_named("activity").count(), 2);
    }

    #[test]
    fn parses_real_camera2_manifest() {
        let root = parse(fixtures::CAMERA2_MANIFEST).unwrap();
        assert_eq!(
            root.plain_attr("package").and_then(Value::as_str),
            Some("com.android.camera2")
        );
        let app = root.child("application").unwrap();
        assert!(app.children_named("activity").count() >= 3);
    }

    #[test]
    fn rejects_non_xml_and_truncated_input() {
        assert!(parse(b"unzip: couldn't open x.apk: I/O error\n").is_none());
        let truncated = &fixtures::CAMERA2_MANIFEST[..fixtures::CAMERA2_MANIFEST.len() / 2];
        // The header claims the full size, so the document is refused.
        assert!(parse(truncated).is_none());
    }
}
