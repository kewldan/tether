import type { MockHandlers } from "@/dev/mockBackend";
import type { CommandOutput } from "@/features/shell/api";

/** A tiny fake `sh` with line editing, enough to try the Shell page. */
interface FakeShell {
  send: (text: string, tag?: number) => void;
  line: string;
  host: string;
  cwd: string;
}

const shells = new Map<number, FakeShell>();
let nextId = 1;

const encoder = new TextEncoder();

const HOSTS: Record<string, string> = {
  "38121FDJH00A4B": "husky",
  "192.168.1.42:37115": "dm1q",
  "emulator-5554": "emu64a",
};

const OUTPUT: Record<string, string> = {
  "getprop ro.product.model": "Pixel 8 Pro",
  'dumpsys battery | grep -E "level|temperature|status"':
    "  status: 2\n  level: 82\n  temperature: 314",
  "dumpsys battery | grep level": "  level: 82",
  "pm list packages -3 | grep example":
    "package:com.example.shop\npackage:com.example.shop.staging",
  "id -u": "2000",
  id: "uid=2000(shell) gid=2000(shell) groups=2000(shell),1004(input),1007(log),1011(adb)",
  "dumpsys activity activities | grep mResumed":
    "    mResumedActivity: ActivityRecord{5f1c2a0 u0 com.example.shop/.MainActivity t412}",
  ls: "acct\napex\nbin\ncache\nconfig\ndata\ndev\netc\nproduct\nsdcard\nstorage\nsystem\nvendor",
  uname: "Linux",
  "ls -la databases":
    "total 412\n-rw-rw---- 1 u0_a312 u0_a312 344064 2026-10-25 22:41 shop.db",
};

function prompt(shell: FakeShell) {
  return `\x1b[32m${shell.host}:${shell.cwd} $\x1b[0m `;
}

function bytes(tag: number, text: string): ArrayBuffer {
  const body = encoder.encode(text);
  const out = new Uint8Array(body.length + 1);
  out[0] = tag;
  out.set(body, 1);
  return out.buffer;
}

function run(shell: FakeShell, command: string): string | null {
  if (command === "exit") return null;
  if (command === "clear") return "\x1b[2J\x1b[H";
  if (command.startsWith("cd ")) {
    shell.cwd = command.slice(3).replace(/^'|'$/g, "") || "/";
    return "";
  }
  if (command === "pwd") return `${shell.cwd}\r\n`;
  if (command.startsWith("echo ")) return `${command.slice(5)}\r\n`;
  const known = OUTPUT[command];
  if (known !== undefined) return `${known.replaceAll("\n", "\r\n")}\r\n`;
  const name = command.split(" ")[0];
  return `\x1b[31m/system/bin/sh: ${name}: inaccessible or not found\x1b[0m\r\n`;
}

const handlers: MockHandlers = {
  shell_open: ({ serial, onOutput }) => {
    const id = nextId++;
    const ch = onOutput as { onmessage: (m: ArrayBuffer) => void };
    const shell: FakeShell = {
      send: (text, tag = 1) => ch.onmessage(bytes(tag, text)),
      line: "",
      host: HOSTS[serial as string] ?? "generic",
      cwd: "/",
    };
    shells.set(id, shell);
    setTimeout(() => shell.send(prompt(shell)), 120);
    return { id, v2: true };
  },
  shell_write: ({ id, data }) => {
    const shell = shells.get(id as number);
    if (!shell)
      throw { kind: "invalid_input", message: "session closed", hint: null };
    for (const ch of data as string) {
      if (ch === "\r") {
        const cmd = shell.line.trim();
        shell.line = "";
        shell.send("\r\n");
        const out = cmd ? run(shell, cmd) : "";
        if (out === null) {
          shells.delete(id as number);
          shell.send("", 3);
          return null;
        }
        shell.send(out + prompt(shell));
      } else if (ch === "\x7f") {
        if (shell.line) {
          shell.line = shell.line.slice(0, -1);
          shell.send("\b \b");
        }
      } else if (ch === "\x03") {
        shell.line = "";
        shell.send(`^C\r\n${prompt(shell)}`);
      } else if (ch >= " ") {
        shell.line += ch;
        shell.send(ch);
      }
    }
    return null;
  },
  shell_resize: () => null,
  shell_close: ({ id }) => {
    shells.delete(id as number);
    return null;
  },
  shell_exec: ({ serial, command }): CommandOutput => {
    const cmd = command as string;
    if (cmd === "id -u; command -v su") {
      const root = serial === "emulator-5554";
      return {
        stdout: root ? "0\n/system/xbin/su\n" : "2000\n",
        stderr: "",
        exitCode: 0,
      };
    }
    const known = OUTPUT[cmd];
    if (known !== undefined)
      return { stdout: `${known}\n`, stderr: "", exitCode: 0 };
    return {
      stdout: "",
      stderr: `/system/bin/sh: ${cmd.split(" ")[0]}: inaccessible or not found\n`,
      exitCode: 127,
    };
  },
};

export default handlers;
