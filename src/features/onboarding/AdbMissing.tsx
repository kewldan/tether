import { useState } from "react";
import { Check, Copy, RefreshCw, TerminalSquare } from "lucide-react";

import { Button } from "@/components/ui/button";

const INSTALL_COMMANDS = [
  { os: "macOS", command: "brew install --cask android-platform-tools" },
  { os: "Windows", command: "winget install Google.PlatformTools" },
  { os: "Debian / Ubuntu", command: "sudo apt install adb" },
  { os: "Fedora", command: "sudo dnf install android-tools" },
  { os: "Arch", command: "sudo pacman -S android-tools" },
] as const;

export function AdbMissing({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 py-16">
      <div className="flex flex-col gap-2">
        <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg">
          <TerminalSquare className="size-5" />
        </div>
        <h1 className="text-xl font-semibold">adb was not found</h1>
        <p className="text-muted-foreground text-sm">
          Install Android platform-tools with your package manager, then check
          again. One-click download is coming soon.
        </p>
      </div>
      <ul className="divide-border ring-foreground/10 divide-y rounded-xl ring-1">
        {INSTALL_COMMANDS.map(({ os, command }) => (
          <InstallRow key={os} os={os} command={command} />
        ))}
      </ul>
      <Button className="self-start" onClick={onRetry}>
        <RefreshCw />
        Check again
      </Button>
    </div>
  );
}

function InstallRow({ os, command }: { os: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span className="text-muted-foreground w-32 shrink-0 text-sm">{os}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-sm">
        {command}
      </code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Copy ${os} command`}
        onClick={copy}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </li>
  );
}
