/*
 * Public plugin API — every type a quilx plugin needs.
 * External plugins: import type { Plugin, PluginContext } from 'quilx/plugin-api'
 * Bundled plugins: import type { ... } from '../../src/plugin-api.ts'
 */
export type { Plugin, PluginManifest, PluginContext, PluginLanguages } from './plugin/types.ts';
export type { LanguageDef, GrammarDef, ServerDef } from './lang/types.ts';
export type { ConfigSchema, ConfigValue } from './util/Config.ts';
export type { Disposable, DisposableLike } from './util/eventKit.ts';
export type { CommandMap } from './CommandManager.ts';
export type { KeymapBySelector } from './KeymapManager.ts';
