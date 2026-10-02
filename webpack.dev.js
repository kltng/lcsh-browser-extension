const { merge } = require('webpack-merge');
const { DefinePlugin } = require('webpack');
const common = require('./webpack.common.js');

module.exports = merge(common, {
  mode: 'development',
  devtool: 'inline-source-map',
  // SPEC-P5 §21: no fault hooks outside the fault-injection test build.
  plugins: [new DefinePlugin({ __LCSH_FAULTS__: false })],
});
