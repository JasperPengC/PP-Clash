/** 仅用于浏览器侧平台判断；真正的系统行为仍以 Rust target 为准。 */
export const isAndroid =
  typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
export const isWindows =
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
export const isLinux =
  typeof navigator !== 'undefined' && /Linux/i.test(navigator.userAgent) && !isAndroid;
