/**
 * Stockage de la clé d'appareil — trousseau OS si disponible, sinon fichier `0600`
 * (consigne de la mission). Pas de module natif (`keytar` et consorts demandent node-gyp — à
 * éviter sur une machine à 12 Go de RAM) : on s'appuie sur les utilitaires déjà présents sur
 * chaque OS, en sous-processus.
 *
 *  - macOS  : `security add-generic-password` / `find-generic-password` / `delete-generic-password`.
 *  - Linux  : `secret-tool` (libsecret — présent sur tout bureau GNOME/KDE ; absent sur un serveur
 *    headless, d'où le repli fichier, le cas réel de ce chantier).
 *  - Windows : pas d'utilitaire CLI fiable sans dépendance — repli fichier direct (documenté comme
 *    limite P1 dans docs/ARCHITECTURE.md).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { NOKKER_KEYCHAIN_SERVICE } from "@nokker-apps/brand";

const execFileAsync = promisify(execFile);

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(platform() === "win32" ? "where" : "which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

export interface Keychain {
  /** `true` si un vrai trousseau OS est utilisé (sinon : fichier). */
  isOsKeychain: boolean;
  set(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string | null>;
  delete(account: string): Promise<void>;
}

async function macosKeychain(): Promise<Keychain | null> {
  if (platform() !== "darwin" || !(await commandExists("security"))) return null;
  return {
    isOsKeychain: true,
    async set(account, secret) {
      await execFileAsync("security", [
        "add-generic-password",
        "-a", account,
        "-s", NOKKER_KEYCHAIN_SERVICE,
        "-w", secret,
        "-U",
      ]);
    },
    async get(account) {
      try {
        const { stdout } = await execFileAsync("security", [
          "find-generic-password",
          "-a", account,
          "-s", NOKKER_KEYCHAIN_SERVICE,
          "-w",
        ]);
        return stdout.trim();
      } catch {
        return null;
      }
    },
    async delete(account) {
      try {
        await execFileAsync("security", ["delete-generic-password", "-a", account, "-s", NOKKER_KEYCHAIN_SERVICE]);
      } catch {
        // déjà absent — pas une erreur.
      }
    },
  };
}

async function linuxSecretTool(): Promise<Keychain | null> {
  if (platform() !== "linux" || !(await commandExists("secret-tool"))) return null;
  return {
    isOsKeychain: true,
    async set(account, secret) {
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          "secret-tool",
          ["store", "--label", NOKKER_KEYCHAIN_SERVICE, "service", NOKKER_KEYCHAIN_SERVICE, "account", account],
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin?.write(secret);
        child.stdin?.end();
      });
    },
    async get(account) {
      try {
        const { stdout } = await execFileAsync("secret-tool", [
          "lookup",
          "service", NOKKER_KEYCHAIN_SERVICE,
          "account", account,
        ]);
        return stdout.length ? stdout : null;
      } catch {
        return null;
      }
    },
    async delete(account) {
      try {
        await execFileAsync("secret-tool", ["clear", "service", NOKKER_KEYCHAIN_SERVICE, "account", account]);
      } catch {
        // déjà absent — pas une erreur.
      }
    },
  };
}

function fileKeychain(filePath: string): Keychain {
  async function load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(filePath, "utf-8")) as Record<string, string>;
    } catch {
      return {};
    }
  }
  async function save(data: Record<string, string>): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(filePath, 0o600); // umask peut relâcher le mode passé à writeFile — on le resserre explicitement.
  }
  return {
    isOsKeychain: false,
    async set(account, secret) {
      const data = await load();
      data[account] = secret;
      await save(data);
    },
    async get(account) {
      const data = await load();
      return data[account] ?? null;
    },
    async delete(account) {
      const data = await load();
      delete data[account];
      await save(data);
    },
  };
}

export async function openKeychain(fallbackFilePath: string): Promise<Keychain> {
  const found = (await macosKeychain()) ?? (await linuxSecretTool());
  if (found) return found;
  return fileKeychain(fallbackFilePath);
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
