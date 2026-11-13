export async function call(method, args) {
  if (!window.paperloom) throw new Error('请从 Paperloom 桌面程序打开文献库')
  const response = await window.paperloom.call(method, args)
  if (!response.ok) throw new Error(response.error)
  return response.value
}
