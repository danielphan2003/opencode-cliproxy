// Runs the real `opencode` binary against an isolated HOME that holds only the vendored plugin
// and a generated opencode.json, so tests never read or write the user's own configuration.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const PLUGIN_SOURCE = path.join(import.meta.dir, "..", "src", "cliproxy.ts")

export interface Sandbox {
  readonly home: string
  readonly project: string
  readonly run: (args: ReadonlyArray<string>, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>
  readonly cleanup: () => void
}

/** Vendors the plugin as `~/.config/opencode/plugins/cliproxy/index.ts`, exactly as the README describes. */
export const sandbox = (options: Record<string, unknown>, extraConfig: Record<string, unknown> = {}): Sandbox => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-cliproxy-test-"))
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  const configDir = path.join(home, ".config", "opencode")
  mkdirSync(path.join(configDir, "plugins", "cliproxy"), { recursive: true })
  mkdirSync(project, { recursive: true })
  cpSync(PLUGIN_SOURCE, path.join(configDir, "plugins", "cliproxy", "index.ts"))
  writeFileSync(
    path.join(configDir, "opencode.json"),
    JSON.stringify({ plugins: [{ package: "./plugins/cliproxy", options }], ...extraConfig }, null, 2),
  )

  const run: Sandbox["run"] = async (args, env = {}) => {
    const child = Bun.spawn(["opencode", ...args, "--standalone"], {
      cwd: project,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TERM: "dumb",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        ...env,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout, stderr }
  }

  return { home, project, run, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Lines of `opencode models` that belong to `providerID`. */
export const modelsOf = (stdout: string, providerID: string) =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${providerID}/`))
    .sort()
