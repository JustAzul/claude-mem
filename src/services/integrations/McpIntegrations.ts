
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { findMcpServerPath } from './CursorHooksInstaller.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { injectContextIntoMarkdownFile } from '../../utils/context-injection.js';

const PLACEHOLDER_CONTEXT = `# claude-mem: Cross-Session Memory

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.`;

function buildMcpServerEntry(mcpServerPath: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [mcpServerPath],
  };
}

function writeMcpJsonConfig(
  configFilePath: string,
  mcpServerPath: string,
  serversKeyName: string = 'mcpServers',
): void {
  const parentDirectory = path.dirname(configFilePath);
  mkdirSync(parentDirectory, { recursive: true });

  const existingConfig = readJsonSafe<Record<string, any>>(configFilePath, {});

  if (!existingConfig[serversKeyName]) {
    existingConfig[serversKeyName] = {};
  }

  existingConfig[serversKeyName]['claude-mem'] = buildMcpServerEntry(mcpServerPath);

  writeFileSync(configFilePath, JSON.stringify(existingConfig, null, 2) + '\n');
}

interface McpInstallerConfig {
  ideId: string;
  ideLabel: string;
  configPath: string;
  configKey: 'servers' | 'mcpServers';
  contextFile?: {
    path: string;
    isWorkspaceRelative: boolean;
  };
}

function installMcpIntegration(config: McpInstallerConfig): () => Promise<number> {
  return async (): Promise<number> => {
    process.stdout.write(`\nInstalling Claude-Mem MCP integration for ${config.ideLabel}...\n\n`);

    const mcpServerPath = findMcpServerPath();
    if (!mcpServerPath) {
      logger.error('SYSTEM', 'MCP integration install failed because the MCP server script was not found', {
        ideId: config.ideId,
        ideLabel: config.ideLabel,
      });
      process.stderr.write('Could not find MCP server script\n');
      process.stderr.write('   Expected at: ~/.claude/plugins/marketplaces/JustAzul/plugin/scripts/mcp-server.cjs\n');
      return 1;
    }

    const configPath = config.configPath;

    const skipWarpConfigWrite = config.ideId === 'warp' && !existsSync(path.dirname(configPath));

    let contextPath: string | undefined;
    if (config.contextFile) {
      contextPath = config.contextFile.path;
    }

    try {
      writeMcpConfigAndContext(config, configPath, mcpServerPath, skipWarpConfigWrite, contextPath);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('SYSTEM', 'MCP integration install failed', {
        ideId: config.ideId,
        error: message,
      });
      console.error(`\nInstallation failed: ${message}`);
      return 1;
    }
  };
}

function writeMcpConfigAndContext(
  config: McpInstallerConfig,
  configPath: string,
  mcpServerPath: string,
  skipWarpConfigWrite: boolean,
  contextPath: string | undefined,
): void {
  if (skipWarpConfigWrite) {
    console.log(`  Note: ~/.warp/ not found. MCP may need to be configured via Warp Drive UI.`);
  } else {
    writeMcpJsonConfig(configPath, mcpServerPath, config.configKey);
    console.log(`  MCP config written to: ${configPath}`);
  }

  if (contextPath) {
    injectContextIntoMarkdownFile(contextPath, PLACEHOLDER_CONTEXT);
    console.log(`  Context placeholder written to: ${contextPath}`);
  }

  const summaryLines = [`\nInstallation complete!\n`];
  summaryLines.push(`MCP config:  ${configPath}`);
  if (contextPath) {
    summaryLines.push(`Context:     ${contextPath}`);
  }
  summaryLines.push('');
  summaryLines.push(`Note: This is an MCP-only integration providing search tools and context.`);
  summaryLines.push(`Transcript capture is not available for ${config.ideLabel}.`);
  if (config.ideId === 'warp') {
    summaryLines.push('If MCP config via file is not supported, configure MCP through Warp Drive UI.');
  }
  summaryLines.push('');
  summaryLines.push('Next steps:');
  summaryLines.push('  1. Start claude-mem worker: npx claude-mem start');
  summaryLines.push(`  2. Restart ${config.ideLabel} to pick up the MCP server`);
  summaryLines.push('');
  console.log(summaryLines.join('\n'));
}

const COPILOT_CLI_CONFIG: McpInstallerConfig = {
  ideId: 'copilot-cli',
  ideLabel: 'Copilot CLI',
  configPath: path.join(homedir(), '.github', 'copilot', 'mcp.json'),
  configKey: 'servers',
  contextFile: {
    path: path.join(process.cwd(), '.github', 'copilot-instructions.md'),
    isWorkspaceRelative: true,
  },
};

const ANTIGRAVITY_CONFIG: McpInstallerConfig = {
  ideId: 'antigravity',
  ideLabel: 'Antigravity',
  configPath: path.join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
  configKey: 'mcpServers',
  contextFile: {
    path: path.join(process.cwd(), '.agents', 'rules', 'claude-mem-context.md'),
    isWorkspaceRelative: true,
  },
};

const ROO_CODE_CONFIG: McpInstallerConfig = {
  ideId: 'roo-code',
  ideLabel: 'Roo Code',
  configPath: path.join(process.cwd(), '.roo', 'mcp.json'),
  configKey: 'mcpServers',
  contextFile: {
    path: path.join(process.cwd(), '.roo', 'rules', 'claude-mem-context.md'),
    isWorkspaceRelative: true,
  },
};

const WARP_CONFIG: McpInstallerConfig = {
  ideId: 'warp',
  ideLabel: 'Warp',
  configPath: path.join(homedir(), '.warp', 'mcp.json'),
  configKey: 'mcpServers',
  contextFile: {
    path: path.join(process.cwd(), 'WARP.md'),
    isWorkspaceRelative: true,
  },
};

function getGooseConfigPath(): string {
  return path.join(homedir(), '.config', 'goose', 'config.yaml');
}

function gooseConfigHasClaudeMemEntry(yamlContent: string): boolean {
  return yamlContent.includes('claude-mem:') &&
    yamlContent.includes('mcpServers:');
}

function buildGooseMcpYamlBlock(mcpServerPath: string): string {
  return [
    'mcpServers:',
    '  claude-mem:',
    `    command: ${process.execPath}`,
    '    args:',
    `      - ${mcpServerPath}`,
  ].join('\n');
}

function buildGooseClaudeMemEntryYaml(mcpServerPath: string): string {
  return [
    '  claude-mem:',
    `    command: ${process.execPath}`,
    '    args:',
    `      - ${mcpServerPath}`,
  ].join('\n');
}

export async function installGooseMcpIntegration(): Promise<number> {
  process.stdout.write('\nInstalling Claude-Mem MCP integration for Goose...\n\n');

  const mcpServerPath = findMcpServerPath();
  if (!mcpServerPath) {
    logger.error('SYSTEM', 'Goose MCP integration install failed because the MCP server script was not found');
    process.stderr.write('Could not find MCP server script\n');
    process.stderr.write('   Expected at: ~/.claude/plugins/marketplaces/JustAzul/plugin/scripts/mcp-server.cjs\n');
    return 1;
  }

  const configPath = getGooseConfigPath();
  const configDirectory = path.dirname(configPath);

  try {
    mkdirSync(configDirectory, { recursive: true });
    mergeGooseYamlConfig(configPath, mcpServerPath);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

function mergeGooseYamlConfig(configPath: string, mcpServerPath: string): void {
  if (existsSync(configPath)) {
    let yamlContent = readFileSync(configPath, 'utf-8');

    if (gooseConfigHasClaudeMemEntry(yamlContent)) {
      const claudeMemPattern = /( {2}claude-mem:\n(?:.*\n)*?(?= {2}\S|\n\n|^\S|$))/m;
      const newEntry = buildGooseClaudeMemEntryYaml(mcpServerPath) + '\n';

      if (!claudeMemPattern.test(yamlContent)) {
        throw new Error('Found mcpServers/claude-mem markers but could not locate a replaceable claude-mem block');
      }
      yamlContent = yamlContent.replace(claudeMemPattern, newEntry);
      writeFileSync(configPath, yamlContent);
      process.stdout.write(`  Updated existing claude-mem entry in: ${configPath}\n`);
    } else if (yamlContent.includes('mcpServers:')) {
      const mcpServersIndex = yamlContent.indexOf('mcpServers:');
      const insertionPoint = mcpServersIndex + 'mcpServers:'.length;
      const newEntry = '\n' + buildGooseClaudeMemEntryYaml(mcpServerPath);

      yamlContent =
        yamlContent.slice(0, insertionPoint) +
        newEntry +
        yamlContent.slice(insertionPoint);

      writeFileSync(configPath, yamlContent);
      process.stdout.write(`  Added claude-mem to existing mcpServers in: ${configPath}\n`);
    } else {
      const mcpBlock = '\n' + buildGooseMcpYamlBlock(mcpServerPath) + '\n';
      yamlContent = yamlContent.trimEnd() + '\n' + mcpBlock;
      writeFileSync(configPath, yamlContent);
      process.stdout.write(`  Appended mcpServers section to: ${configPath}\n`);
    }
  } else {
    const templateContent = buildGooseMcpYamlBlock(mcpServerPath) + '\n';
    writeFileSync(configPath, templateContent);
    process.stdout.write(`  Created config with MCP server: ${configPath}\n`);
  }

  process.stdout.write(`
Installation complete!

MCP config:  ${configPath}

Note: This is an MCP-only integration providing search tools and context.
Transcript capture is not available for Goose.

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Goose to pick up the MCP server
`);
}

export const MCP_IDE_INSTALLERS: Record<string, () => Promise<number>> = {
  'copilot-cli': installMcpIntegration(COPILOT_CLI_CONFIG),
  'antigravity': installMcpIntegration(ANTIGRAVITY_CONFIG),
  'goose': installGooseMcpIntegration,
  'roo-code': installMcpIntegration(ROO_CODE_CONFIG),
  'warp': installMcpIntegration(WARP_CONFIG),
};
