import { resolveGatewayPort } from "../config/config.js";
import type { GatewayBindMode, OpenClawConfig } from "../config/types.js";
import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { isValidIPv4, pickPrimaryLanIPv4 } from "./net.js";

function pickPrimaryLanIPv4Safe(): string | undefined {
  try {
    return pickPrimaryLanIPv4() ?? undefined;
  } catch {
    return undefined;
  }
}

function pickPrimaryTailnetIPv4Safe(): string | undefined {
  try {
    return pickPrimaryTailnetIPv4() ?? undefined;
  } catch {
    return undefined;
  }
}

export function resolveControlUiLinks(params: {
  port: number;
  bind?: GatewayBindMode;
  customBindHost?: string;
  basePath?: string;
}): { httpUrl: string; wsUrl: string } {
  const port = params.port;
  const bind = params.bind ?? "loopback";
  const customBindHost = params.customBindHost?.trim();
  const host = (() => {
    if (bind === "custom" && customBindHost && isValidIPv4(customBindHost)) {
      return customBindHost;
    }
    if (bind === "tailnet") {
      const tailnetIPv4 = pickPrimaryTailnetIPv4Safe();
      return tailnetIPv4 ?? "127.0.0.1";
    }
    if (bind === "lan") {
      return pickPrimaryLanIPv4Safe() ?? "127.0.0.1";
    }
    return "127.0.0.1";
  })();
  const basePath = normalizeControlUiBasePath(params.basePath);
  const uiPath = basePath ? `${basePath}/` : "/";
  const wsPath = basePath ? basePath : "";
  return {
    httpUrl: `http://${host}:${port}${uiPath}`,
    wsUrl: `ws://${host}:${port}${wsPath}`,
  };
}

export function resolveDashboardHttpUrl(cfg: OpenClawConfig): string {
  const bind = cfg.gateway?.bind ?? "loopback";
  return resolveControlUiLinks({
    port: resolveGatewayPort(cfg),
    // LAN URLs fail secure-context checks in browsers.
    // Coerce only lan->loopback and preserve other bind modes.
    bind: bind === "lan" ? "loopback" : bind,
    customBindHost: cfg.gateway?.customBindHost,
    basePath: cfg.gateway?.controlUi?.basePath,
  }).httpUrl;
}
