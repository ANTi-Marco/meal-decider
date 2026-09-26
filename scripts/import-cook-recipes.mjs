import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSV_URLS = [
  'https://cdn.jsdelivr.net/gh/YunYouJun/cook@main/app/data/recipe.csv',
  'https://raw.githubusercontent.com/YunYouJun/cook/main/app/data/recipe.csv',
  'https://api.github.com/repos/YunYouJun/cook/contents/app/data/recipe.csv?ref=main',
];
const upstreamLicense = `MIT License

Copyright (c) 2022 云游君 YunYouJun <me@yunyoujun.cn>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(projectRoot, 'dist/recipes.json');
const noticePath = resolve(projectRoot, 'THIRD_PARTY_NOTICES.md');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

function splitList(value) {
  return [...new Set(String(value || '')
    .split(/[、，,|/]/)
    .map(item => item.trim())
    .filter(Boolean))];
}

function inferTags(recipe) {
  const text = [recipe.name, ...recipe.ingredients, ...recipe.sourceTags, ...recipe.methods, ...recipe.tools].join(' ');
  const rules = [
    ['香辣', /辣|麻婆|麻辣|香锅|川味|湘味|咖喱|烧烤|烤串/],
    ['清淡', /清汤|蒸|粥|羹|沙拉|轻食|水煮|素食|减脂/],
    ['酸甜', /番茄|糖醋|酸甜|咕咾|菠萝|柠檬|橙香/],
    ['咸香', /炒|焖|煎|烤|卤|炸|面|饭|饺|包|排骨/],
    ['protein', /鸡肉|猪肉|牛肉|鱼|虾|鸡蛋|豆腐|午餐肉|香肠|腊肠|骨头/],
    ['lowcal', /减脂|低卡|轻食|沙拉|素食|清汤|蒸菜/],
    ['balanced', /杂烩|时蔬|蔬菜|番茄|胡萝卜|花菜|菌菇|包菜|白菜|西葫芦/],
    ['quick', /微波炉|方便面|速食|简单|懒人|快手/],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
}

function makeId(recipe) {
  return `cook-${createHash('sha1')
    .update(`${recipe.name}|${recipe.bv}|${recipe.ingredients.join('|')}`)
    .digest('hex')
    .slice(0, 12)}`;
}

async function fetchText(urls, label) {
  let lastError;
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'meal-decider-recipe-import' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      if (url.includes('api.github.com')) {
        const payload = await response.json();
        return Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8');
      }
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${label} download failed`, { cause: lastError });
}

const csvText = await fetchText(CSV_URLS, 'Recipe data');

const rows = parseCsv(csvText);
const headers = rows.shift().map(header => header.trim());
const seen = new Set();
const recipes = [];

for (const row of rows) {
  const source = Object.fromEntries(headers.map((header, index) => [header, row[index] || '']));
  const recipe = {
    name: source.name.trim(),
    ingredients: splitList(source.stuff),
    bv: source.bv.trim(),
    difficulty: source.difficulty.trim() || '难度未知',
    sourceTags: splitList(source.tags),
    methods: splitList(source.methods),
    tools: splitList(source.tools),
  };
  if (!recipe.name) continue;
  const dedupeKey = `${recipe.name}|${recipe.bv}|${recipe.ingredients.join('|')}`;
  if (seen.has(dedupeKey)) continue;
  seen.add(dedupeKey);
  recipes.push({ id: makeId(recipe), ...recipe, tags: inferTags(recipe) });
}

recipes.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({
  source: 'YunYouJun/cook',
  sourceUrl: 'https://github.com/YunYouJun/cook',
  license: 'MIT',
  generatedAt: new Date().toISOString(),
  count: recipes.length,
  recipes,
}, null, 2)}\n`, 'utf8');

await writeFile(noticePath, `# Third-party notices\n\n## YunYouJun/cook\n\nRecipe data in \`dist/recipes.json\` is derived from [YunYouJun/cook](https://github.com/YunYouJun/cook).\n\nLicense: MIT\n\n\`\`\`text\n${upstreamLicense.trim()}\n\`\`\`\n`, 'utf8');
console.log(`Generated ${recipes.length} recipes at ${outputPath}`);
