/**
 * SPEC-P5 §21 "Build": the configuration checks. They inspect the EFFECTIVE
 * webpack configurations (after webpack-merge), not the source text. They do
 * not replace the inspection of the emitted production package.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import vitestConfig from '../../../../vitest.config.js';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../../..');
const load = (name) => require(path.join(root, name));
const { DefinePlugin } = require('webpack');

const definitionsOf = (config) => (config.plugins || [])
  .filter((plugin) => plugin instanceof DefinePlugin)
  .map((plugin) => plugin.definitions);

describe('[P5 §21] __LCSH_FAULTS__ is defined exactly once per configuration', () => {
  it('production: the literal false, production mode, the minimizer on, no source maps, output dist/', () => {
    const prod = load('webpack.prod.js');
    expect(definitionsOf(prod)).toEqual([{ __LCSH_FAULTS__: false }]);
    expect(prod.mode).toBe('production');
    expect(prod.optimization?.minimize).not.toBe(false);
    expect(prod.devtool).toBeFalsy();
    expect(prod.output.path).toBe(path.join(root, 'dist'));
  });

  it('development: the literal false', () => {
    const dev = load('webpack.dev.js');
    expect(definitionsOf(dev)).toEqual([{ __LCSH_FAULTS__: false }]);
    expect(dev.output.path).toBe(path.join(root, 'dist'));
  });

  it('faults: the literal true, the production build otherwise, output ONLY to dist-faults/', () => {
    const faults = load('webpack.faults.js');
    const prod = load('webpack.prod.js');
    expect(definitionsOf(faults)).toEqual([{ __LCSH_FAULTS__: true }]);
    expect(faults.mode).toBe('production');
    expect(faults.optimization?.minimize).not.toBe(false);
    expect(faults.devtool).toBeFalsy();
    expect(faults.output.path).toBe(path.join(root, 'dist-faults'));
    // Same entries, loaders and copied manifest; only the definition and the output path differ.
    expect(faults.entry).toEqual(prod.entry);
    expect(faults.module).toEqual(prod.module);
    expect(faults.plugins.filter((p) => !(p instanceof DefinePlugin)).map((p) => p.constructor.name))
      .toEqual(prod.plugins.filter((p) => !(p instanceof DefinePlugin)).map((p) => p.constructor.name));
    expect({ ...faults.output, path: null }).toEqual({ ...prod.output, path: null });
  });

  it('vitest defines it as true for the hook tests, and the fault output is gitignored', async () => {
    expect(vitestConfig.define).toEqual({ __LCSH_FAULTS__: true });
    expect(__LCSH_FAULTS__).toBe(true);
    const fs = await import('node:fs');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')).toContain('dist-faults/');
    // No npm script builds or ships the fault package.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(JSON.stringify(pkg.scripts)).not.toMatch(/faults/);
  });
});
