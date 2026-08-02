declare module "openclaw/plugin-sdk/core" {
  export interface PluginLogger {
    debug?: (message: string, ...args: unknown[]) => void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
  }

  export type AnyAgentTool = Record<string, unknown>;

  export interface OpenClawPluginApi {
    logger: PluginLogger;
    pluginConfig?: Record<string, unknown>;
    runtime?: any;
    registerTool(...args: any[]): void;
    registerHook(...args: any[]): void;
    on(...args: any[]): void;
    llmTask?: (...args: any[]) => Promise<any>;
  }
}
