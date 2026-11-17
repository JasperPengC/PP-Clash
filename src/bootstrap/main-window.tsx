import App from '../App';
import { useApp } from '../store/app';

// 主窗口拥有业务状态；小面板只消费快照，不初始化主 store。
void useApp.getState().hydrate();
if (import.meta.env.DEV) {
  void import('../dev/preview').then(module => module.applyPreviewIfRequested());
}

export default App;
