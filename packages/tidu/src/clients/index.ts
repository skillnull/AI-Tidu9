import { accessSync, constants, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

export type LocalClientId = "codex" | "cursor" | "openai-cli";
export type LocalClientReadiness = "configurable" | "limited" | "not-detected";
export type LocalClientLimitation = "cursor-standard-chat-only";
export type LocalClientIntegrationMode = "native-agent" | "virtual-model" | "not-detected";

export interface LocalClientSignals {
  /** Whether at least one known command is available on PATH. */
  command: boolean;
  /** Whether a known desktop application installation is present. */
  application: boolean;
  /** Whether a known configuration file already exists; its contents are never read. */
  configuration: boolean;
  /** Whether an official full-capability agent protocol command is available. */
  agentProtocol: boolean;
}

export interface LocalClientDiscoveryItem {
  /** Stable client identifier used by future configuration adapters. */
  id: LocalClientId;
  /** User-facing client name. */
  name: string;
  /** Whether any non-sensitive installation signal was found. */
  detected: boolean;
  /** Current integration readiness without claiming that configuration is already complete. */
  readiness: LocalClientReadiness;
  /** Highest-fidelity integration mode currently discoverable for this client. */
  integrationMode: LocalClientIntegrationMode;
  /** OpenAI-compatible fallback protocol used when native Agent delegation is unavailable. */
  protocol: "chat-completions" | "responses";
  /** Non-sensitive signals used to determine presence. */
  signals: LocalClientSignals;
  /** Stable code for an honest current capability limitation. */
  limitation: LocalClientLimitation | null;
}

export interface LocalClientDiscovery {
  /** Schema version for forward-compatible discovery consumers. */
  schemaVersion: "1";
  /** Device operating system used for candidate selection. */
  platform: NodeJS.Platform;
  /** Timestamp when this snapshot was created. */
  detectedAt: string;
  /** Supported local clients and their current discovery state. */
  clients: readonly LocalClientDiscoveryItem[];
  /** Privacy guarantee applied during this discovery pass. */
  privacy: "metadata-only";
}

export interface LocalClientDiscoveryEnvironment {
  /** Home directory override used by isolated tests and embedded runtimes. */
  homeDirectory?: string;
  /** PATH override; an empty value disables command discovery. */
  executablePath?: string;
  /** PATHEXT override used for Windows command discovery. */
  executableExtensions?: string;
  /** APPDATA override used for Windows configuration discovery. */
  applicationDataDirectory?: string;
  /** LOCALAPPDATA override used for Windows application discovery. */
  localApplicationDataDirectory?: string;
  /** Operating-system override used by isolated tests. */
  operatingSystem?: NodeJS.Platform;
  /** Clock override used to create deterministic snapshots. */
  now?: () => Date;
}

interface LocalClientDefinition {
  /** Stable client identifier. */
  id: LocalClientId;
  /** User-facing client name. */
  name: string;
  /** Known command names checked without executing them. */
  commands: readonly string[];
  /** OpenAI-compatible protocol used by this client integration. */
  protocol: LocalClientDiscoveryItem["protocol"];
  /** Limitation applied when the client is detected. */
  limitation: LocalClientLimitation | null;
}

const CLIENT_DEFINITIONS: readonly LocalClientDefinition[] = [
  {
    id: "codex",
    name: "Codex",
    commands: ["codex"],
    protocol: "responses",
    limitation: null,
  },
  {
    id: "cursor",
    name: "Cursor",
    commands: ["cursor", "cursor-agent", "agent"],
    protocol: "chat-completions",
    limitation: "cursor-standard-chat-only",
  },
  {
    id: "openai-cli",
    name: "OpenAI CLI",
    commands: ["openai"],
    protocol: "responses",
    limitation: null,
  },
];

const isFile = (candidatePath: string): boolean => {
  try {
    return statSync(candidatePath).isFile();
  } catch {
    return false;
  }
};

const isDirectory = (candidatePath: string): boolean => {
  try {
    return statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
};

const resolveExecutableExtensions = (
  operatingSystem: NodeJS.Platform,
  configuredExtensions: string | undefined,
): readonly string[] => {
  if (operatingSystem !== "win32") {
    return [""];
  }
  const extensions = (configuredExtensions ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension !== "");
  return ["", ...extensions];
};

const hasCommand = (
  commandNames: readonly string[],
  executablePath: string,
  operatingSystem: NodeJS.Platform,
  executableExtensions: string | undefined,
): boolean => {
  const pathDelimiter = operatingSystem === "win32" ? ";" : delimiter;
  const searchDirectories = executablePath
    .split(pathDelimiter)
    .map((directory) => directory.trim())
    .filter((directory) => directory !== "");
  const extensions = resolveExecutableExtensions(operatingSystem, executableExtensions);

  return commandNames.some((commandName) =>
    searchDirectories.some((directory) =>
      extensions.some((extension) => {
        const candidatePath = join(directory, `${commandName}${extension}`);
        if (!isFile(candidatePath)) {
          return false;
        }
        if (operatingSystem === "win32") {
          return true;
        }
        try {
          accessSync(candidatePath, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
    ),
  );
};

const resolveApplicationCandidates = (
  clientId: LocalClientId,
  environment: Required<
    Pick<LocalClientDiscoveryEnvironment, "homeDirectory" | "operatingSystem">
  > &
    Pick<LocalClientDiscoveryEnvironment, "localApplicationDataDirectory">,
): readonly string[] => {
  if (environment.operatingSystem === "darwin") {
    const applicationName = clientId === "codex" ? "Codex.app" : "Cursor.app";
    if (clientId === "openai-cli") {
      return [];
    }
    return [
      join("/Applications", applicationName),
      join(environment.homeDirectory, "Applications", applicationName),
    ];
  }
  if (environment.operatingSystem === "win32") {
    if (environment.localApplicationDataDirectory === undefined || clientId === "openai-cli") {
      return [];
    }
    const applicationDirectory = clientId === "codex" ? "Codex" : "Programs/Cursor";
    return [join(environment.localApplicationDataDirectory, applicationDirectory)];
  }
  if (clientId === "cursor") {
    return [
      join(environment.homeDirectory, ".local/share/applications/cursor.desktop"),
      "/usr/share/applications/cursor.desktop",
    ];
  }
  return [];
};

const resolveConfigurationCandidates = (
  clientId: LocalClientId,
  environment: Required<
    Pick<LocalClientDiscoveryEnvironment, "homeDirectory" | "operatingSystem">
  > &
    Pick<LocalClientDiscoveryEnvironment, "applicationDataDirectory">,
): readonly string[] => {
  if (clientId === "codex") {
    return [join(environment.homeDirectory, ".codex/config.toml")];
  }
  if (clientId === "openai-cli") {
    return [];
  }
  if (environment.operatingSystem === "darwin") {
    return [
      join(environment.homeDirectory, "Library/Application Support/Cursor/User/settings.json"),
    ];
  }
  if (environment.operatingSystem === "win32") {
    return environment.applicationDataDirectory === undefined
      ? []
      : [join(environment.applicationDataDirectory, "Cursor/User/settings.json")];
  }
  return [join(environment.homeDirectory, ".config/Cursor/User/settings.json")];
};

export const discoverLocalClients = (
  environment: LocalClientDiscoveryEnvironment = {},
): LocalClientDiscovery => {
  const resolvedEnvironment = {
    homeDirectory: environment.homeDirectory ?? homedir(),
    executablePath: environment.executablePath ?? process.env.PATH ?? "",
    executableExtensions: environment.executableExtensions ?? process.env.PATHEXT,
    applicationDataDirectory: environment.applicationDataDirectory ?? process.env.APPDATA,
    localApplicationDataDirectory:
      environment.localApplicationDataDirectory ?? process.env.LOCALAPPDATA,
    operatingSystem: environment.operatingSystem ?? platform(),
    now: environment.now ?? (() => new Date()),
  };

  const clients = CLIENT_DEFINITIONS.map((definition): LocalClientDiscoveryItem => {
    const signals: LocalClientSignals = {
      command: hasCommand(
        definition.commands,
        resolvedEnvironment.executablePath,
        resolvedEnvironment.operatingSystem,
        resolvedEnvironment.executableExtensions,
      ),
      application: resolveApplicationCandidates(definition.id, resolvedEnvironment).some(
        (candidatePath) => isDirectory(candidatePath) || isFile(candidatePath),
      ),
      configuration: resolveConfigurationCandidates(definition.id, resolvedEnvironment).some(
        isFile,
      ),
      agentProtocol:
        definition.id === "codex"
          ? hasCommand(
              ["codex"],
              resolvedEnvironment.executablePath,
              resolvedEnvironment.operatingSystem,
              resolvedEnvironment.executableExtensions,
            )
          : definition.id === "cursor"
            ? hasCommand(
                ["agent", "cursor-agent"],
                resolvedEnvironment.executablePath,
                resolvedEnvironment.operatingSystem,
                resolvedEnvironment.executableExtensions,
              )
            : false,
    };
    const detected =
      signals.command || signals.application || signals.configuration || signals.agentProtocol;
    return {
      id: definition.id,
      name: definition.name,
      detected,
      readiness: detected
        ? definition.limitation === null || signals.agentProtocol
          ? "configurable"
          : "limited"
        : "not-detected",
      integrationMode: !detected
        ? "not-detected"
        : signals.agentProtocol
          ? "native-agent"
          : "virtual-model",
      protocol: definition.protocol,
      signals,
      limitation: detected && !signals.agentProtocol ? definition.limitation : null,
    };
  });

  return {
    schemaVersion: "1",
    platform: resolvedEnvironment.operatingSystem,
    detectedAt: resolvedEnvironment.now().toISOString(),
    clients,
    privacy: "metadata-only",
  };
};

export const formatLocalClientDiscovery = (discovery: LocalClientDiscovery): string => {
  const lines = discovery.clients.map((client) => {
    const status =
      client.readiness === "configurable"
        ? "detected · configurable"
        : client.readiness === "limited"
          ? "detected · limited"
          : "not detected";
    const signals = Object.entries(client.signals)
      .filter(([, present]) => present)
      .map(([signal]) => signal)
      .join(", ");
    return `${client.name}: ${status} · ${client.integrationMode}${
      signals === "" ? "" : ` (${signals})`
    }`;
  });
  return [
    `Local clients · ${discovery.platform} · metadata only`,
    ...lines,
    "No credentials, account data, history, or configuration contents were read.",
  ].join("\n");
};
