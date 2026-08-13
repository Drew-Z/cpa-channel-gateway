export function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (value === null) return 'null'
  return JSON.stringify(String(value))
}

export function yamlList(values) {
  return `[${values.map(yamlScalar).join(', ')}]`
}
