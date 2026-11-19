import { createContext, useContext, type ReactNode } from 'react';
import { IconChevronRight } from './icons';

/** 移动端导航由外壳提供，业务页面共用标题、摘要与操作布局。 */
export const MobilePageNavigation = createContext<{ back?: () => void } | null>(null);

export function PageHeader({ title, mobileTitle, subtitle, mobileSubtitle, children, className = '' }: {
  title: string;
  mobileTitle?: string;
  subtitle?: ReactNode;
  mobileSubtitle?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const mobile = useContext(MobilePageNavigation);
  const detail = mobile && mobileSubtitle !== undefined ? mobileSubtitle : subtitle;
  return <header className={`page-head ${className}`.trim()}>
    {mobile?.back && <button type="button" className="android-back" aria-label="返回更多" onClick={mobile.back}>
      <IconChevronRight size={20} style={{ transform: 'rotate(180deg)' }} />
    </button>}
    <div className="page-heading">
      <h1 className="page-title">{mobile && mobileTitle ? mobileTitle : title}</h1>
      {detail != null && <div className="page-sub">{detail}</div>}
    </div>
    {children && <div className="page-actions">{children}</div>}
  </header>;
}
