import { useQuery } from "@tanstack/react-query";
import { Minus, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";

import { logcatPackages } from "../api";
import { logBuffer } from "../session";

const PACKAGE_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;

/** "+ Package" combobox; picking one filters by it and follows its PID. */
export function PackagePicker({
  serial,
  onPick,
}: {
  serial: string | null;
  onPick: (name: string) => void;
}) {
  const { t } = useTranslation("logcat");
  const [open, setOpen] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [search, setSearch] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["logcat-packages", serial],
    queryFn: () => (serial ? logcatPackages(serial) : Promise.resolve([])),
    enabled: open && serial !== null,
    staleTime: 60_000,
  });

  const user = data?.filter((p) => p.thirdParty) ?? [];
  const system = data?.filter((p) => !p.thirdParty) ?? [];
  const pick = (name: string) => {
    onPick(name);
    setOpen(false);
    setSearch("");
  };
  const exact = data?.some((p) => p.name === search);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="text-caption">
            <Plus className="size-3" aria-hidden />
            {t("package.add")}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-80 p-0">
        <Command>
          <CommandInput
            placeholder={t("package.search")}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-80">
            <CommandEmpty>
              {isLoading ? t("package.loading") : t("package.empty")}
            </CommandEmpty>
            {search && !exact && PACKAGE_RE.test(search) && (
              <CommandItem
                value={`custom ${search}`}
                onSelect={() => pick(search)}
              >
                {t("package.custom", { name: search })}
              </CommandItem>
            )}
            {user.length > 0 && (
              <CommandGroup heading={t("package.userApps")}>
                {user.map((p) => (
                  <CommandItem
                    key={p.name}
                    value={p.name}
                    onSelect={() => pick(p.name)}
                    className="text-small font-mono"
                  >
                    {p.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {(showSystem || search.length > 1) && system.length > 0 && (
              <CommandGroup heading={t("package.systemApps")}>
                {system.map((p) => (
                  <CommandItem
                    key={p.name}
                    value={p.name}
                    onSelect={() => pick(p.name)}
                    className="text-small font-mono"
                  >
                    {p.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          <div className="text-small text-secondary-foreground flex items-center justify-between gap-2 border-t px-3 py-2">
            <span id="logcat-show-system">{t("package.showSystem")}</span>
            <Switch
              aria-labelledby="logcat-show-system"
              checked={showSystem}
              onCheckedChange={setShowSystem}
            />
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** "+ Tag" popover: type a tag or pick a frequent one, include or exclude. */
export function TagPicker({
  onInclude,
  onExclude,
}: {
  onInclude: (tag: string) => void;
  onExclude: (tag: string) => void;
}) {
  const { t, i18n } = useTranslation("logcat");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  // Read when opened; the buffer changes too often to track live here.
  const frequent = useMemo(() => (open ? logBuffer.topTags(200) : []), [open]);
  const query = text.trim().toLowerCase();
  const shown = frequent
    .filter(([tag]) => !query || tag.toLowerCase().includes(query))
    .slice(0, 40);
  const nf = new Intl.NumberFormat(i18n.language, { notation: "compact" });

  const done = (fn: (tag: string) => void, tag: string) => {
    if (!tag) return;
    fn(tag);
    setText("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="text-caption">
            <Plus className="size-3" aria-hidden />
            {t("tags.add")}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-72 gap-2 p-2">
        <input
          // biome-ignore lint/a11y/noAutofocus: popover input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              done(e.shiftKey ? onExclude : onInclude, text.trim());
            }
          }}
          placeholder={t("tags.placeholder")}
          aria-label={t("tags.placeholder")}
          spellCheck={false}
          className="border-input bg-background focus-visible:border-ring text-small h-7 w-full rounded-[7px] border px-2.5 font-mono outline-none"
        />
        <p className="text-caption text-muted-foreground px-0.5">
          {t("tags.hint")}
        </p>
        {shown.length > 0 && (
          <div className="flex max-h-64 flex-col overflow-y-auto">
            <div className="text-caption text-muted-foreground px-1 pt-1 pb-0.5 font-semibold tracking-wide uppercase">
              {t("tags.frequent")}
            </div>
            {shown.map(([tag, count]) => (
              <div
                key={tag}
                className="hover:bg-accent group flex h-7 items-center gap-1 rounded-sm px-1"
              >
                <span className="text-small min-w-0 flex-1 truncate font-mono">
                  {tag}
                </span>
                <span className="text-muted-foreground num text-caption">
                  {nf.format(count)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${t("tags.include")}: ${tag}`}
                  title={t("tags.include")}
                  onClick={() => done(onInclude, tag)}
                >
                  <Plus />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${t("tags.exclude")}: ${tag}`}
                  title={t("tags.exclude")}
                  onClick={() => done(onExclude, tag)}
                >
                  <Minus />
                </Button>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
