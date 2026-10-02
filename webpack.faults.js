/**
 * SPEC-P5 §21: the fault-injection TEST build. It is the production build
 * (production mode, the production minimizer, the same manifest and CSP) with
 * `__LCSH_FAULTS__` defined as `true`, and it writes only to `dist-faults/`.
 * It merges `webpack.common.js` directly, not `webpack.prod.js`, so the
 * effective configuration holds exactly ONE definition of the constant.
 *
 * Run it directly: `npx webpack --config webpack.faults.js`. Never ship it.
 */
const path = require('path');
const { merge } = require('webpack-merge');
const { DefinePlugin } = require('webpack');
const common = require('./webpack.common.js');

module.exports = merge(common, {
  mode: 'production',
  plugins: [new DefinePlugin({ __LCSH_FAULTS__: true })],
  output: {
    path: path.resolve(__dirname, 'dist-faults'),
  },
});
