const { merge } = require('webpack-merge');
const { DefinePlugin } = require('webpack');
const common = require('./webpack.common.js');

module.exports = merge(common, {
  mode: 'production',
  // SPEC-P5 §21: the shipped package compiles every fault hook out.
  plugins: [new DefinePlugin({ __LCSH_FAULTS__: false })],
});
