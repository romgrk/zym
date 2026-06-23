/*
 * Tests for the Markdown plugin's contributions — activated against throwaway
 * `LanguageRegistry` / `Config` instances via a partial `PluginContext`, so the
 * global singletons aren't touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry } from '../../src/lang/index.ts';
import { Config, type ConfigSchema } from '../../src/util/Config.ts';
import { Disposable } from '../../src/util/eventKit.ts';
import type { PluginContext, PluginLanguages } from '../../src/plugin/types.ts';
import { markdownPlugin } from './index.ts';

function activate(): { reg: LanguageRegistry; config: Config } {
  const reg = new LanguageRegistry();
  const config = new Config();
  const languages: PluginLanguages = {
    registerLanguage: (def) => reg.registerLanguage(def),
    registerGrammar: (id, def) => reg.registerGrammar(id, def),
    registerServer: (id, def) => reg.registerServer(id, def),
    registerInjection: (rule) => reg.registerInjection(rule),
  };
  const ctx = {
    id: 'markdown',
    dir: '/plugins/markdown',
    resolve: (p: string) => `/plugins/markdown/${p}`,
    languages,
    registerConfig: (schema: Record<string, ConfigSchema>) => {
      config.addSchema(schema);
      return new Disposable(() => {
        for (const key of Object.keys(schema)) config.removeSchema(key);
      });
    },
    // The image-preview feature subscribes here; no editors exist in this unit test.
    observeTextEditors: () => new Disposable(() => {}),
  } as unknown as PluginContext;
  markdownPlugin.activate(ctx);
  return { reg, config };
}

test('detects Markdown by extension; lspLanguageId is markdown', () => {
  const { reg } = activate();
  assert.equal(reg.languageForPath('/d/README.md'), 'markdown');
  assert.equal(reg.languageForPath('/d/notes.markdown'), 'markdown');
  assert.equal(reg.languageForPath('/d/x.mkd'), 'markdown');
  assert.equal(reg.languageForPath('/d/x.ts'), null); // not this plugin's concern
  assert.equal(reg.lspLanguageId('/d/README.md'), 'markdown');
});

test('marksman activates single-file (no project markers) and prefers a root', () => {
  const { reg } = activate();
  // singleFile: activates with no markers, rooted at the file's directory.
  const loose = reg.activeServers('/some/where/a.md', { fileExists: () => false });
  assert.deepEqual(loose.map((a) => a.server.name), ['marksman']);
  assert.equal(loose[0].rootDir, '/some/where');
  // With a marker present, the root is the nearest ancestor holding it.
  const rooted = reg.activeServers('/proj/docs/a.md', {
    fileExists: (p) => p === '/proj/.marksman.toml',
  });
  assert.equal(rooted[0].rootDir, '/proj');
});

test('contributes a markdown.* config schema with valid enum defaults', () => {
  const { config } = activate();
  for (const key of [
    'markdown.preferredHeadingStyle',
    'markdown.preferredBulletMarker',
    'markdown.preferredEmphasisMarker',
  ]) {
    const schema = config.getSchema(key);
    assert.ok(schema, `${key} should be declared`);
    // The declared default must be a permitted enum value (Config rejects otherwise).
    assert.ok(config.set(key, schema!.default));
    assert.equal(config.get(key), schema!.default);
  }
  assert.equal(config.getDefault('markdown.preferredHeadingStyle'), 'atx');
});
