/**
 * 迷你 DOM 测试台：在 Node 里执行打包后的页面脚本，验证界面行为。
 *
 * 为什么需要它：真正的浏览器/无头 Chrome 在受限环境里时用时不可用，
 * 而界面逻辑（谁该看见什么、点了会发生什么）又必须能自动验证。
 * 这里用一个最小但够用的 DOM 实现跑真实产物，不依赖任何外部依赖或权限。
 *
 * 支持的选择器：#id、.class、tag.name、多 class（.a.b）、后代（#a .b）。
 */

import { runInNewContext } from 'node:vm';

// ---------------------------------------------------------------------------
// 最小 DOM 实现
// ---------------------------------------------------------------------------

class ClassList {
  constructor(element) {
    this.el = element;
  }

  get set() {
    return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean));
  }

  write(set) {
    this.el.className = [...set].join(' ');
  }

  add(...names) {
    const set = this.set;
    for (const name of names) set.add(name);
    this.write(set);
  }

  remove(...names) {
    const set = this.set;
    for (const name of names) set.delete(name);
    this.write(set);
  }

  contains(name) {
    return this.set.has(name);
  }

  toggle(name, force) {
    const has = this.contains(name);
    const want = force === undefined ? !has : force;
    if (want) this.add(name);
    else this.remove(name);
    return want;
  }
}

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this._style = {};
    this.dataset = {};
    this.listeners = new Map();
    this._text = '';
    this._html = '';
    this.value = '';
    this.disabled = false;
    this.checked = false;
    this.classList = new ClassList(this);
  }

  get className() {
    return this.attributes.get('class') ?? '';
  }

  set className(value) {
    this.attributes.set('class', String(value));
  }

  get id() {
    return this.attributes.get('id') ?? '';
  }

  set id(value) {
    this.attributes.set('id', String(value));
  }

  /**
   * style：真实浏览器里 `el.style = ''` 会清空内联样式，而 `el.style.color = 'x'`
   * 又能继续赋值。这里用 getter/setter 复现这个行为，避免界面代码里的清空操作报错。
   */
  get style() {
    return this._style;
  }

  set style(value) {
    this._style = typeof value === 'string' ? {} : value || {};
  }

  /** innerHTML：赋值时把 HTML 解析成真正的子元素，这样内部元素可以被查到。 */
  get innerHTML() {
    if (this.children.length === 0) return this._rawHtml ?? '';
    return this.children.map((c) => (c.tagName === '#TEXT' ? c.textContent : c.outerHTML)).join('');
  }

  set innerHTML(value) {
    const html = String(value);
    this._rawHtml = html;
    this.children = [];
    if (!html.trim()) return;
    const tree = parseHTML(html);
    for (const child of [...tree.children]) this.appendChild(child);
  }

  /** 近似 textContent：自身文本 + 所有后代文本。 */
  get textContent() {
    if (this.children.length === 0) return this._text || this._rawHtml || '';
    return this._text + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
    this._rawHtml = '';
    this.children = [];
  }

  get outerHTML() {
    return `<${this.tagName.toLowerCase()}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  setAttribute(name, value) {
    if (name === 'hidden') this.hidden = true;
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    if (name === 'hidden') this.hidden = false;
    this.attributes.delete(name);
  }

  get hidden() {
    return this.attributes.get('hidden') === 'true';
  }

  set hidden(value) {
    // 与浏览器一致：hidden = false 会移除属性，而不是写 "false"
    if (value) this.attributes.set('hidden', 'true');
    else this.attributes.delete('hidden');
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((h) => h !== handler));
  }

  dispatchEvent(event) {
    const handlers = [...(this.listeners.get(event.type) ?? [])];
    if (typeof this['on' + event.type] === 'function') handlers.push(this['on' + event.type]);
    for (const handler of handlers) handler.call(this, event);
    return true;
  }

  click() {
    this.dispatchEvent(makeEvent('click', this));
  }

  querySelectorAll(selector) {
    return selectAll(this, selector.trim());
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** document 一级 API：按 id 取元素（整个文档里第一个匹配）。 */
  getElementById(id) {
    return selectAll(this, '#' + id)[0] ?? null;
  }

  getElementsByClassName(name) {
    return selectAll(this, '.' + String(name).trim().split(/\s+/).join('.'));
  }

  getElementsByTagName(tag) {
    return selectAll(this, tag);
  }

  createElement(tag) {
    return new Element(tag);
  }
}

function makeEvent(type, target) {
  return {
    type,
    target,
    currentTarget: target,
    preventDefault() {},
    stopPropagation() {},
  };
}

/** 解析简单选择器：支持 A B（后代）、.a.b、#id、tag（含 h1-h6 这类带数字的标签名）。 */
function matches(element, part) {
  const tokens = part.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
  if (!tokens) return false;
  const [, tag, rest] = tokens;
  if (tag && element.tagName !== tag.toUpperCase()) return false;
  for (const piece of rest.match(/[.#][\w-]+/g) ?? []) {
    if (piece[0] === '#') {
      if (element.id !== piece.slice(1)) return false;
    } else if (!element.classList.contains(piece.slice(1))) {
      return false;
    }
  }
  return true;
}

/**
 * 选择器求值：从左到右逐段收窄候选集合（后代关系）。
 * 支持 tag / #id / .class 以及它们的组合，段之间用空格分隔。
 */
export function selectAll(root, selector) {
  const parts = selector.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  let candidates = [root];
  for (const part of parts) {
    const next = [];
    for (const node of candidates) {
      // 后代：子树 + 直接子元素（简化处理，够用且不会漏掉 #a > b 这类常见写法）
      walk(node, (child) => {
        if (matches(child, part)) next.push(child);
      });
    }
    candidates = next;
    if (candidates.length === 0) return [];
  }
  return candidates;
}

/** 深度优先遍历子树（不含 root 自身，但包含直接子元素）。 */
function walk(root, visit) {
  for (const child of root.children) {
    visit(child);
    walk(child, visit);
  }
}

/** 极简 HTML 解析：只认标签、属性、文本，不做容错。 */
function parseHTML(html) {
  const root = new Element('root');
  const stack = [root];
  let index = 0;
  const voidTags = new Set(['meta', 'link', 'br', 'hr', 'img', 'input']);

  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt < 0) break;
    const text = html.slice(index, lt);
    if (text.trim()) stack[stack.length - 1].appendChild(textNode(text));
    const gt = html.indexOf('>', lt);
    if (gt < 0) break;
    const raw = html.slice(lt + 1, gt).trim();

    if (raw.startsWith('!--') || raw.startsWith('!doctype') || raw.startsWith('!DOCTYPE')) {
      index = gt + 1;
      continue;
    }
    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      index = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const nameMatch = body.match(/^([a-zA-Z][\w-]*)/);
    if (!nameMatch) {
      index = gt + 1;
      continue;
    }
    const element = new Element(nameMatch[1]);
    for (const attr of body.slice(nameMatch[1].length).matchAll(/([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const [, name, dq, sq, bare] = attr;
      element.setAttribute(name, dq ?? sq ?? bare ?? '');
    }
    stack[stack.length - 1].appendChild(element);
    const isVoid = voidTags.has(nameMatch[1].toLowerCase());
    if (!selfClosing && !isVoid) stack.push(element);
    index = gt + 1;
  }
  return root;
}

function textNode(text) {
  const node = new Element('#text');
  node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// 假时钟：settle 时推进定时器，让 UI 里的 setTimeout 逻辑可测
// ---------------------------------------------------------------------------

function createClock() {
  const queue = [];
  let now = 0;
  // 定时器 id 必须单调递增且永不复用（真实浏览器行为）。
  // 早期实现用 queue.length + 1，已取消的 id 会被复用，
  // 导致"用 id 追踪挂起定时器"的代码误删别的定时器——这是一个真实的坑。
  let nextId = 1;
  const setTimeout_ = (fn, delay = 0) => {
    const id = nextId++;
    queue.push({ id, at: now + Number(delay || 0), fn });
    return id;
  };
  const clearTimeout_ = (id) => {
    const index = queue.findIndex((t) => t.id === id);
    if (index >= 0) queue.splice(index, 1);
  };
  const settle = (limit = 5000) => {
    let steps = 0;
    while (queue.length > 0 && steps < limit) {
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const task = queue.shift();
      now = task.at;
      task.fn();
      steps += 1;
    }
    return steps;
  };
  return { setTimeout: setTimeout_, clearTimeout: clearTimeout_, settle, pending: () => queue.length };
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 载入打包后的单文件页面，返回可操作的沙箱。
 * @param {string} html 单文件 HTML 内容
 * @returns {{document: Element, window: object, clock: object, errors: string[], el: (id: string) => Element}}
 */
export function createPage(html) {
  const document = new Element('#document');
  const body = new Element('body');
  document.appendChild(body);

  // 只解析 <body> 里的内容（head 里的样式对断言没影响）
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyTree = parseHTML(bodyMatch ? bodyMatch[1] : html);
  for (const child of [...bodyTree.children]) body.appendChild(child);

  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  const script = scriptMatch ? scriptMatch[1] : '';

  const clock = createClock();
  const errors = [];
  const window = {
    document,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    addEventListener(type, handler) {
      if (type === 'error') errors.push('window error 监听已注册');
    },
    removeEventListener() {},
  };

  const sandbox = {
    window,
    document,
    console,
    Math,
    Date,
    JSON,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Set,
    Map,
    Error,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  runInNewContext(script, sandbox, { filename: '白饭牌.html' });

  return {
    document,
    window,
    clock,
    errors,
    el: (id) => document.querySelector('#' + id),
    /** 当前游戏状态（UI 通过 window.BaiFan.__uiState 暴露；每次现取，避免闭包拿到旧引用） */
    state: () => {
      const api = sandbox.window?.BaiFan ?? window.BaiFan;
      return api && api.__uiState ? api.__uiState() : null;
    },
    /** 该元素当前是否可见（考虑 hidden 与 .overlay） */
    visible: (node) => Boolean(node) && !node.hidden,
  };
}

export { Element, parseHTML };
