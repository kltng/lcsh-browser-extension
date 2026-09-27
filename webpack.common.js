const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: {
    popup: './src/popup.jsx',
    background: './src/background.js',
    app: './src/app.jsx',
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env', '@babel/preset-react'],
          },
        },
      },
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: 'assets', to: 'assets' },
        // The SQLite wasm is NOT copied here: webpack rewrites sqlite-wasm's
        // `new URL('sqlite3.wasm', import.meta.url)` into a content-hashed
        // asset and emits it, and that is the file the worker loads. It ships
        // inside the package either way (HOUSE_RULES 3, no remote code); a
        // second copy would only add ~849 KiB of dead weight.
      ],
    }),
    new HtmlWebpackPlugin({
      template: './src/popup.html',
      filename: 'popup.html',
      chunks: ['popup'],
    }),
    new HtmlWebpackPlugin({
      template: './src/app.html',
      filename: 'app.html',
      chunks: ['app'],
    }),
  ],
  // The `sqlite3-worker1` entry of @sqlite.org/sqlite-wasm contains a dynamic
  // import. We never use it (the worker installs the SAH-pool VFS directly),
  // and every file it could reach is packaged, so nothing is loaded remotely.
  ignoreWarnings: [
    { module: /sqlite3-worker1\.mjs$/, message: /Critical dependency/ },
  ],
  resolve: {
    extensions: ['.js', '.jsx'],
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
}; 