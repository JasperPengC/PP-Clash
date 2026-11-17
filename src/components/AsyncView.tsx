import { Component, Suspense, createElement, lazy, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';

class ViewBoundary extends Component<{ children: ReactNode; retry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="empty" role="alert">
      <div className="empty-title">页面加载失败</div>
      <button type="button" className="btn btn-sm" onClick={this.props.retry}>重试</button>
    </div>;
  }
}

/** 首次显示才请求模块；只缓存成功加载，重试创建新的 React.lazy 状态。 */
export function asyncView<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  let pending: ReturnType<typeof load> | undefined;
  const loadCached = () => pending ??= load().catch(error => { pending = undefined; throw error; });
  let View = lazy(loadCached);
  return function AsyncView(props: ComponentProps<T>) {
    const [attempt, setAttempt] = useState(0);
    return <ViewBoundary key={attempt} retry={() => { View = lazy(loadCached); setAttempt(value => value + 1); }}>
      <Suspense fallback={<div className="empty" role="status" aria-live="polite"><span className="spinner" />加载中…</div>}>
        {createElement(View, props)}
      </Suspense>
    </ViewBoundary>;
  };
}
