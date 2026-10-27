// Facet schema for the generated sample items (fixtures/items.js).
const schema = [
  { key: 'category', type: 'enum', label: 'Category' },
  { key: 'tags', type: 'tags', label: 'Tags' },
  { key: 'region', type: 'enum', label: 'Region' },
  { key: 'price', type: 'range', label: 'Price (credits)', options: { step: 0.01 } },
  { key: 'rating', type: 'range', label: 'Rating', options: { min: 1, max: 5, step: 0.1 } },
  { key: 'year', type: 'range', label: 'Year', options: { step: 1 } },
];

export default schema;
