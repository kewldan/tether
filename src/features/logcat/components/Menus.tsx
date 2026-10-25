import { ChevronDown, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { modKey } from "@/lib/platform";

import { BUFFERS, type BufferName } from "../api";
import { isDefaultFilter } from "../filter";
import { activePreset, type Preset, useLogcatUi } from "../store";

export function usePresetName() {
  const { t } = useTranslation("logcat");
  return (p: Preset) => (p.builtin ? t(`presets.${p.builtin}`) : p.name);
}

/** "Filters: <preset>" — apply, save and delete presets. */
export function PresetMenu({ onSave }: { onSave: () => void }) {
  const { t } = useTranslation("logcat");
  const presets = useLogcatUi((s) => s.presets);
  const filter = useLogcatUi((s) => s.filter);
  const applyPreset = useLogcatUi((s) => s.applyPreset);
  const deletePreset = useLogcatUi((s) => s.deletePreset);
  const resetFilter = useLogcatUi((s) => s.resetFilter);
  const name = usePresetName();
  const active = activePreset(presets, filter);
  const label = active
    ? name(active)
    : isDefaultFilter(filter)
      ? t("actions.filtersNone")
      : t("actions.filtersCustom");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className="max-w-56">
            <span className="truncate">
              {t("actions.filters", { name: label })}
            </span>
            <ChevronDown aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("details.presets")}</DropdownMenuLabel>
          {presets.map((p, i) => (
            <DropdownMenuItem
              key={p.id}
              onClick={() => applyPreset(p.id)}
              className={p.id === active?.id ? "bg-selected" : undefined}
            >
              <span className="truncate">{name(p)}</span>
              {i < 9 && (
                <DropdownMenuShortcut>
                  {modKey}
                  {i + 1}
                </DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSave}>
          <Plus />
          {t("presets.save")}
        </DropdownMenuItem>
        {!isDefaultFilter(filter) && (
          <DropdownMenuItem onClick={resetFilter}>
            <RotateCcw />
            {t("presets.reset")}
          </DropdownMenuItem>
        )}
        {active && !active.builtin && (
          <DropdownMenuItem
            variant="destructive"
            onClick={() => deletePreset(active.id)}
          >
            <Trash2 />
            {t("presets.delete", { name: active.name })}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SavePresetDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (name: string) => void;
}) {
  const { t } = useTranslation("logcat");
  const savePreset = useLogcatUi((s) => s.savePreset);
  const [name, setName] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    savePreset(trimmed);
    setName("");
    onOpenChange(false);
    onSaved(trimmed);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("presets.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("presets.dialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="logcat-preset-name">{t("presets.nameLabel")}</Label>
            <Input
              id="logcat-preset-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("presets.namePlaceholder")}
              maxLength={60}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              {t("presets.saveButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Buffer: main, crash" — which logcat ring buffers to stream. */
export function BufferMenu({
  buffers,
  onChange,
}: {
  buffers: BufferName[];
  onChange: (buffers: BufferName[]) => void;
}) {
  const { t } = useTranslation("logcat");
  const toggle = (b: BufferName, on: boolean) => {
    const next = on
      ? BUFFERS.filter((x) => x === b || buffers.includes(x))
      : buffers.filter((x) => x !== b);
    if (next.length > 0) onChange(next);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className="max-w-64">
            <span className="truncate">
              {t("actions.buffer", { list: buffers.join(", ") })}
            </span>
            <ChevronDown aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("buffers.label")}</DropdownMenuLabel>
          {BUFFERS.map((b) => (
            <DropdownMenuCheckboxItem
              key={b}
              checked={buffers.includes(b)}
              onCheckedChange={(on) => toggle(b, on)}
              className="font-mono"
            >
              {t(`buffers.${b}`)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
