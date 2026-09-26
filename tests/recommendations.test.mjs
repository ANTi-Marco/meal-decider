import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const start = html.indexOf('    function recent(');
const end = html.indexOf('    function recipeList()', start);
assert.ok(start > 0 && end > start, 'recommendation functions should exist');
const recommend = new Function('state', 'liveRestaurants', 'sessionSeen', `${html.slice(start, end)};return restaurantList()`);
const tagStart = html.indexOf('    function inferRestaurantTags(');
const tagEnd = html.indexOf('    async function loadAmapRestaurants()', tagStart);
assert.ok(tagStart > 0 && tagEnd > tagStart, 'restaurant tag rules should exist');
const inferTags = new Function('item', `${html.slice(tagStart, tagEnd)};return inferRestaurantTags(item)`);

test('any taste and 10km range can recommend nearby, middle and distant restaurants', () => {
  const state = { radius: 'all', budget: 50, tastes: ['随便'], nutrition: 'none', people: '1', history: [], activeMeal: null };
  const liveRestaurants = [0.1, 0.2, 4, 4.5, 7, 8].map((distance, index) => ({
    id: `restaurant-${index}`, distance, cost: 50, tags: [],
  }));
  const result = recommend(state, liveRestaurants, new Set());
  assert.equal(result.length, 3);
  assert.ok(result.some(item => item.distance < 3.33));
  assert.ok(result.some(item => item.distance >= 3.33 && item.distance < 6.67));
  assert.ok(result.some(item => item.distance >= 6.67));
});

test('light taste and calorie control exclude hotpot and barbecue even when their names suggest soup or salad', () => {
  const state = { radius: 'all', budget: 50, tastes: ['清淡'], nutrition: 'lowcal', people: '1', history: [], activeMeal: null };
  const names = ['清汤火锅', '轻食烧烤', '鸡胸肉沙拉'];
  const restaurants = names.map((name, index) => ({
    id: `restaurant-${index}`, name, distance: index + 1, cost: 50,
    tags: inferTags({ name, category: '中餐厅', type: '餐饮服务' }),
  }));
  const result = recommend(state, restaurants, new Set());
  assert.deepEqual(result.map(item => item.name), ['鸡胸肉沙拉']);
  assert.equal(recommend(state, restaurants.slice(0, 2), new Set()).length, 0);
});

test('salty and protein preferences keep a near-budget match and label uncertain alternatives', () => {
  const state = { radius: '5', budget: 50, tastes: ['咸香'], nutrition: 'protein', people: '2', history: [], activeMeal: null };
  const names = ['喜家德虾仁水饺', '浓厚拉面', '鸡汤馆', '咖啡店'];
  const restaurants = names.map((name, index) => ({
    id: `restaurant-${index}`, name, distance: index + .1, cost: [37, 47, 52, 50][index],
    category: '餐厅', tags: inferTags({ name, category: '餐厅', type: '餐饮服务' }),
  }));
  const result = recommend(state, restaurants, new Set());
  assert.equal(result.length, 3);
  assert.equal(result[0].name, names[0]);
  assert.equal(result[0].matchTier, 'match');
  assert.ok(result.slice(1).every(item => item.matchTier === 'partial'));
  assert.ok(result.every(item => item.name !== '咖啡店'));
});

test('two diners increase the weight of group-friendly restaurants', () => {
  const weight = new Function('state', 'item', `${html.slice(start, end)};return groupWeight(item)`);
  const item = { name: '家常餐馆', category: '中餐厅', tags: ['group'] };
  assert.equal(weight({ people: '1' }, item), 1);
  assert.ok(weight({ people: '2' }, item) > weight({ people: '1' }, item));
});
