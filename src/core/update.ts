export const APP_VERSION = __APP_VERSION__;

/**
 * 内置更新源：只走 GitHub Releases。
 * 仓库变更时只改这一处，或构建时设置 VITE_UPDATE_REPO。
 */
export const UPDATE_REPO =
  (import.meta.env.VITE_UPDATE_REPO as string | undefined)?.trim() ||
  'JasperPengC/pp-clash';
