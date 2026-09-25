function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function isKeyValue(text) {
  if (!text.includes(':')) return false;
  const split = splitKey(text);
  if (!split.key) return false;
  if (split.rest === '' && !text.trim().endsWith(':')) return false;
  return true;
}

function unquote(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    return JSON.parse(text);
  }
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~' || text === '') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  return text;
}

export function parse(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  if (source.trim().startsWith('{') || source.trim().startsWith('[')) return JSON.parse(source);
  const lines = source.split(/\r?\n/).map((raw) => {
    const expanded = raw.replace(/\t/g, '  ');
    const content = stripComment(expanded).trimEnd();
    return {
      indent: content.match(/^\s*/)[0].length,
      text: content.trim(),
    };
  }).filter((line) => line.text);

  let index = 0;
  function peek() { return lines[index]; }
  function parseBlock(indent) {
    const line = peek();
    if (!line || line.indent < indent) return null;
    if (line.text.startsWith('- ')) return parseList(indent);
    return parseMap(indent);
  }
  function parseMap(indent) {
    const map = {};
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent < indent || line.text.startsWith('- ')) break;
      if (line.indent > indent) throw new Error(`Unexpected indent near ${line.text}`);
      const split = splitKey(line.text);
      index += 1;
      if (split.rest === '') {
        const next = peek();
        map[split.key] = next && next.indent > indent ? parseBlock(next.indent) : null;
      } else if (split.rest === '|' || split.rest === '>') {
        map[split.key] = parseLiteral(indent);
      } else {
        map[split.key] = unquote(split.rest);
      }
    }
    return map;
  }
  function parseList(indent) {
    const list = [];
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent < indent || !line.text.startsWith('- ')) break;
      if (line.indent > indent) throw new Error(`Unexpected indent near ${line.text}`);
      const rest = line.text.slice(2).trim();
      index += 1;
      if (!rest) {
        const next = peek();
        list.push(next && next.indent > indent ? parseBlock(next.indent) : null);
        continue;
      }
      if (rest.startsWith('- ')) throw new Error('Nested lists on one line are not supported');
      if (isKeyValue(rest)) {
        const split = splitKey(rest);
        const item = {};
        if (split.rest === '') {
          const next = peek();
          item[split.key] = next && next.indent > line.indent ? parseBlock(next.indent) : null;
        } else {
          item[split.key] = unquote(split.rest);
        }
        while (index < lines.length && lines[index].indent > indent && !lines[index].text.startsWith('- ')) {
          const child = lines[index];
          const part = splitKey(child.text);
          index += 1;
          if (part.rest === '') {
            const next = peek();
            item[part.key] = next && next.indent > child.indent ? parseBlock(next.indent) : null;
          } else {
            item[part.key] = unquote(part.rest);
          }
        }
        list.push(item);
      } else {
        list.push(unquote(rest));
      }
    }
    return list;
  }
  function parseLiteral(indent) {
    const chunks = [];
    while (index < lines.length && lines[index].indent > indent) {
      chunks.push(lines[index].text);
      index += 1;
    }
    return chunks.join('\n');
  }
  if (!lines.length) return null;
  const value = parseBlock(lines[0].indent);
  if (index < lines.length) throw new Error(`Could not parse YAML near ${lines[index].text}`);
  return value;
}

function splitKey(text) {
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':') {
      const key = unquote(text.slice(0, i).trim());
      return { key: String(key), rest: text.slice(i + 1).trim() };
    }
  }
  return { key: unquote(text), rest: '' };
}

function quote(value) {
  return JSON.stringify(value);
}

function dump(value, indent) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map((item) => `${pad}- ${dumpInline(item, indent + 1)}`).join('\n');
  }
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  return entries.map(([key, item]) => `${pad}${quoteKey(key)}: ${dumpChild(item, indent)}`).join('\n');
}

function quoteKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : quote(key);
}

function dumpChild(value, indent) {
  if (value !== null && typeof value === 'object') {
    const nested = dump(value, indent + 1);
    if (Array.isArray(value) && value.length) return `\n${nested}`;
    if (!Array.isArray(value) && Object.keys(value).length) return `\n${nested}`;
  }
  return dump(value, indent + 1);
}

function dumpInline(value, indent) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const [firstKey, firstValue] = entries[0];
    const head = `${quoteKey(firstKey)}: ${dumpChild(firstValue, indent)}`;
    const rest = entries.slice(1).map(([key, item]) => `${'  '.repeat(indent)}${quoteKey(key)}: ${dumpChild(item, indent)}`).join('\n');
    return rest ? `${head}\n${rest}` : head;
  }
  return dump(value, indent);
}

export function stringify(value) {
  if (value === null || value === undefined) return 'null\n';
  return `${dump(value, 0)}\n`;
}
