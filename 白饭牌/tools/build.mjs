/**
 * 零依赖打包器：把 web/index.html 模板 + src 下的 ESM 模块合成一个自包含 HTML。
 *
 * 为什么需要它：浏览器不允许 file:// 协议加载 ES module（CORS），
 * 所以「双击就能玩」必须把模块内联成一个普通 <script>。
 *
 * 做法：按依赖顺序拼接模块，去掉 import/export 关键字。
 * 只要各模块顶层标识符不重名即可——build 时会检查并在冲突时报错。
 *
 * 用法：node tools/build.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

/** 模块顺序：被依赖的在前。 */
const MODULES = [
  'src/engine/random.js',
  'src/engine/cards.js',
  'src/engine/rules.js',
  'src/skills/registry.js',
  'src/skills/skills.js',
  'src/engine/game.js',
  'src/ai/heuristics.js',
  'src/ai/search.js',
  'src/ai/profiles.js',
  'src/ai/hints.js',
];

/** 去掉 import 语句与 export 关键字，保留其余代码。 */
function stripModuleSyntax(source, file) {
  let text = source;
  // import ... from '...'  以及裸 import '...'
  text = text.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  text = text.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');
  // export const / export function / export class / export { ... }
  text = text.replace(/^export\s+(const|let|var|function|class|async)\b/gm, '$1');
  text = text.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  if (/^\s*(import|export)\b/m.test(text)) {
    throw new Error(`${file} 中仍有未处理的 import/export 语句，请更新 build 脚本的剥离规则`);
  }
  return text.trim();
}

/** 收集顶层声明名，检测跨模块重名。 */
function topLevelNames(source) {
  const names = new Set();
  const patterns = [
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^function\s+([A-Za-z_$][\w$]*)/gm,
    /^class\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

function buildBundle() {
  const parts = [];
  const seen = new Map();

  for (const file of MODULES) {
    const source = read(file);
    const stripped = stripModuleSyntax(source, file);
    for (const name of topLevelNames(stripped)) {
      if (seen.has(name)) {
        throw new Error(`顶层标识符冲突：${name} 同时存在于 ${seen.get(name)} 与 ${file}`);
      }
      seen.set(name, file);
    }
    parts.push(`// ─── ${file} ${'─'.repeat(Math.max(0, 60 - file.length))}\n${stripped}`);
  }

  const exports = [...seen.keys()].sort();
  const bundle = [
    '(function () {',
    "'use strict';",
    '',
    parts.join('\n\n'),
    '',
    '// 暴露给调试用（浏览器控制台可访问）',
    `window.BaiFan = { ${exports.join(', ')} };`,
    '',
    '// ─── UI 层（与模块同处一个作用域，因此能直接用上面的函数） ───',
    '__UI__',
    '})();',
  ].join('\n');
  return { bundle, exports };
}

/** 源码指纹：任何模块/界面改动都会改变它，用于确认产物是不是最新的。 */
function sourceFingerprint(uiSource) {
  const texts = [...MODULES.map((file) => read(file)), uiSource, read('web/index.html')];
  let h = 2166136261 >>> 0;
  for (const text of texts) {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function main() {
  const template = read('web/index.html');
  if (!template.includes('__BUNDLE__')) {
    throw new Error('web/index.html 里找不到 __BUNDLE__ 占位符');
  }
  const uiSource = read('web/ui.js');
  const { bundle, exports } = buildBundle();
  const filled = bundle.replace('__UI__', () => uiSource.trim());
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const fingerprint = sourceFingerprint(uiSource);

  // 自检标记：脚本跑到底后把 #boot 的 data-boot 设为 ok，并写入源码指纹。
  // 浏览器里可以直接确认"脚本是否跑完"以及"产物是不是最新源码构建的"。
  const selfCheck = `
try {
  var boot = document.getElementById('boot');
  if (boot) {
    boot.setAttribute('data-boot', 'ok');
    boot.setAttribute('data-fingerprint', '${fingerprint}');
  }
} catch (error) { /* 自检失败不影响游戏 */ }
`;

  const output = template
    .replace('__BUNDLE__', () => `${filled}\n${selfCheck}`)
    .replace('__BUILD_STAMP__', () => `${stamp}（${MODULES.length} 模块 + UI）`);

  const outFile = path.join(root, '白饭牌.html');
  fs.writeFileSync(outFile, output, 'utf8');

  const sizeKb = (Buffer.byteLength(output, 'utf8') / 1024).toFixed(1);
  console.log(`✅ 已生成 白饭牌.html（${sizeKb} KB，源码指纹 ${fingerprint}）`);
  console.log(`   内联模块 ${MODULES.length} 个 + UI 1 个，顶层声明 ${exports.length} 个，无重名冲突`);
}

export { sourceFingerprint, MODULES };

// 直接运行时才构建；被 ui-test.mjs 引入时只取指纹函数。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`❌ 打包失败：${error.message}`);
    process.exit(1);
  }
}
