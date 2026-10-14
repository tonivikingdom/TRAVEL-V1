import React, { useEffect, useRef, useState } from 'react';
import '../generated/GeneratedComponent.css';
type TripStatus = '出行中' | '待出行' | '已结束';
type Trip = {
  id: number;
  title: string;
  range: string;
  region: string;
  duration: string;
  status: TripStatus;
  cover: string;
  totalCost: string | null;
  travelers: number | null;
};
// SYNTHETIC UI preview only. Unknown total cost and traveler count remain null.
const tripData: Trip[] = [
  {
    totalCost: null,
    travelers: null,
    id: 1,
    title: '日本 · 樱花之旅',
    range: '2026.10.10 — 2026.10.18',
    region: '东京 · 京都 · 大阪',
    duration: '9天',
    status: '出行中',
    cover: '/assets/f619eb2cd6e0c20f6e42.jpg',
  },
  {
    totalCost: null,
    travelers: null,
    id: 2,
    title: '瑞士 · 湖光山色之旅',
    range: '2026.12.20 — 2026.12.30',
    region: '苏黎世 · 因特拉肯',
    duration: '11天',
    status: '待出行',
    cover: '/assets/722c72e365410ff0a240.jpg',
  },
  {
    totalCost: null,
    travelers: null,
    id: 3,
    title: '冰岛 · 极光追寻之旅',
    range: '2027.02.06 — 2027.02.16',
    region: '雷克雅未克 · 黄金圈',
    duration: '11天',
    status: '待出行',
    cover: '/assets/8cc9c7d10e76072e6202.jpg',
  },
  {
    totalCost: null,
    travelers: null,
    id: 4,
    title: '意大利 · 托斯卡纳之旅',
    range: '2026.05.12 — 2026.05.22',
    region: '佛罗伦萨 · 锡耶纳',
    duration: '11天',
    status: '已结束',
    cover: '/assets/ccc4233b387b0ddc0c3b.jpg',
  },
];
const filters = ['全部', '出行中', '待出行', '已结束'] as const;
type Filter = (typeof filters)[number];
type IconName =
  | 'search'
  | 'bell'
  | 'plus'
  | 'more'
  | 'pin'
  | 'plane'
  | 'clock'
  | 'check'
  | 'user'
  | 'settings'
  | 'help'
  | 'logout'
  | 'x';
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    search: (
      <>
        <circle cx="10.8" cy="10.8" r="6.6" />
        <path d="m16 16 5 5" />
      </>
    ),
    bell: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </>
    ),
    plus: <path d="M12 4.5v15M4.5 12h15" />,
    more: (
      <>
        <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
      </>
    ),
    pin: (
      <>
        <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
        <circle cx="12" cy="10" r="2.3" />
      </>
    ),
    plane: <path d="m2 20 20-8L2 4l5 8-5 8ZM7 12h15" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l4 2" />
      </>
    ),
    check: <path d="m4 12 5.5 5.5L20 6" />,
    user: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c.2-6 13.8-6 14 0" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1m0-14.2L17 7m-10 10-2.1 2.1" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9a3 3 0 1 1 5 2.2c-2 .9-2 1.9-2 3.3M12 18h.01" />
      </>
    ),
    logout: (
      <>
        <path d="M10 3H4v18h6M9 12h12m-5-5 5 5-5 5" />
      </>
    ),
    x: <path d="M5 5 19 19M19 5 5 19" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
function BrandLogo() {
  return (
    <div className="tp2-brand" aria-label="旅途计划 Travel Planner">
      <div className="tp2-brand-symbol">
        <svg width="38" height="31" viewBox="0 0 40 32" aria-hidden="true">
          <path d="M2 26 16 4l9 13 5-7 9 16h-9l-6-8-7 9h-8L16 15 9 26Z" fill="#3386DC" />
          <path d="m16 4 9 13-5 7-6-9 2-11Z" fill="#76B7F4" />
        </svg>
      </div>
      <div className="tp2-brand-words">
        <b>旅途计划</b>
        <span>TRAVEL PLANNER</span>
      </div>
    </div>
  );
}
function Tag({ status }: { status: TripStatus }) {
  return (
    <span
      className={
        'tp2-tag tp2-tag-' +
        (status === '出行中' ? 'traveling' : status === '待出行' ? 'future' : 'done')
      }
      style={{
        width: '90px',
        maxWidth: '90px',
        height: '30px',
        translate: '0px 4px',
      }}
    >
      {status === '出行中' ? (
        <Icon name="pin" size={15} />
      ) : status === '待出行' ? (
        <Icon name="plane" size={15} />
      ) : (
        <Icon name="check" size={15} />
      )}
      {status}
    </span>
  );
}
export const DesktopHome = () => {
  const [filter, setFilter] = useState<Filter>('全部');
  const [searchText, setSearchText] = useState('');
  const [openPanel, setOpenPanel] = useState<'none' | 'search' | 'notifications' | 'account'>(
    'none'
  );
  const [tripMenu, setTripMenu] = useState<number | null>(null);
  const [infoMessage, setInfoMessage] = useState('');
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenPanel('none');
        setTripMenu(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);
  const getCount = (f: Filter) =>
    f === '全部' ? tripData.length : tripData.filter(t => t.status === f).length;
  const displayed = tripData.filter(t => filter === '全部' || t.status === filter);
  const searchResults = tripData.filter(t =>
    (t.title + t.region).toLowerCase().includes(searchText.trim().toLowerCase())
  );
  return (
    <div
      className="tp2-desktop"
      onClick={e => {
        if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
          setOpenPanel('none');
        }
        if (!(e.target as HTMLElement).closest('.tp2-trip-actions')) setTripMenu(null);
      }}
    >
      <div className="tp2-header-wrap" ref={headerRef}>
        <header className="tp2-header">
          <BrandLogo />
          <div className="tp2-header-right">
            <div className="tp2-search-shell">
              <Icon name="search" size={19} />
              <input
                aria-label="搜索旅程"
                placeholder="搜索旅程、目的地或备注"
                value={searchText}
                onFocus={() => {
                  setOpenPanel('search');
                  setTripMenu(null);
                }}
                onChange={e => setSearchText(e.target.value)}
              />
              {openPanel === 'search' && (
                <div className="tp2-search-dropdown" onClick={e => e.stopPropagation()}>
                  <div className="tp2-menu-label">{searchText ? '搜索结果' : '最近旅程'}</div>
                  {searchResults.length ? (
                    searchResults.slice(0, 4).map(t => (
                      <button
                        key={t.id}
                        onClick={() => {
                          setSearchText(t.title);
                          setOpenPanel('none');
                        }}
                      >
                        <Icon name="search" size={15} />
                        <span>{t.title}</span>
                        <small>{t.region}</small>
                      </button>
                    ))
                  ) : (
                    <p className="tp2-empty-small">没有找到相关旅程</p>
                  )}
                </div>
              )}
            </div>
            <button
              className="tp2-bell"
              aria-label="通知"
              aria-expanded={openPanel === 'notifications'}
              onClick={() => {
                setOpenPanel(openPanel === 'notifications' ? 'none' : 'notifications');
                setTripMenu(null);
              }}
            >
              <Icon name="bell" size={22} />
              <i />
            </button>
            <button
              className="tp2-avatar-button"
              aria-label="头像菜单"
              aria-expanded={openPanel === 'account'}
              onClick={() => {
                setOpenPanel(openPanel === 'account' ? 'none' : 'account');
                setTripMenu(null);
              }}
            >
              <span className="tp2-avatar-picture" />
            </button>
          </div>
        </header>
        {openPanel === 'notifications' && (
          <div
            className="tp2-pop tp2-pop-notifications"
            onClick={e => e.stopPropagation()}
            style={{
              width: '360px',
              maxWidth: '360px',
            }}
          >
            <div className="tp2-pop-title">
              <b>最近通知</b>
              <button onClick={() => setOpenPanel('none')} aria-label="关闭通知">
                <Icon name="x" size={15} />
              </button>
            </div>
            <div className="tp2-notify unread">
              <span className="tp2-notify-icon">
                <Icon name="plane" size={17} />
              </span>
              <div>
                <b>航班动态更新</b>
                <p>你关注的航班信息有变化</p>
                <small>10分钟前</small>
              </div>
              <i
                style={{
                  width: '12px',
                  maxWidth: '12px',
                  height: '12px',
                  translate: '-10px 20px',
                }}
              />
            </div>
            <div className="tp2-notify">
              <span className="tp2-notify-icon">
                <Icon name="clock" size={17} />
              </span>
              <div>
                <b>出行提醒</b>
                <p>北海道旅程已进入出行阶段</p>
                <small>昨天</small>
              </div>
            </div>
            <div className="tp2-pop-bottom">最近通知 · 包含已读和未读</div>
          </div>
        )}
        {openPanel === 'account' && (
          <div
            className="tp2-pop tp2-pop-account"
            onClick={e => e.stopPropagation()}
            style={{
              width: '300px',
              maxWidth: '300px',
            }}
          >
            <div className="tp2-account-head">
              <span className="tp2-avatar-picture tp2-avatar-large" />
              <div>
                <b>个人账户</b>
                <span>旅行爱好者</span>
              </div>
            </div>
            <div className="tp2-account-links">
              {[
                ['个人资料', 'user'],
                ['账户设置', 'settings'],
                ['帮助与反馈', 'help'],
              ].map(([label, icon]) => (
                <button
                  key={label}
                  onClick={() => setInfoMessage(label + '的具体页面将在后续评审中确定')}
                >
                  <Icon name={icon as IconName} size={17} />
                  {label}
                </button>
              ))}
            </div>
            <button
              className="tp2-signout"
              onClick={() => setInfoMessage('退出登录交互将在后续评审中确定')}
            >
              <Icon name="logout" size={17} />
              退出登录
            </button>
          </div>
        )}
      </div>
      <section className="tp2-hero" aria-label="探索世界">
        <div className="tp2-hero-photo" />
        <div className="tp2-hero-overlay" />
        <div className="tp2-content tp2-hero-inside">
          <div className="tp2-hero-copy">
            <span className="tp2-overline">YOUR NEXT JOURNEY STARTS HERE</span>
            <h1>去看更大的世界</h1>
            <p className="tp2-hero-subtitle">用行程，收藏生活的风景</p>
            <span className="tp2-hero-line" />
            <p className="tp2-hero-sentence">每一段旅程，都值得认真期待。</p>
          </div>
        </div>
      </section>
      <main className="tp2-content tp2-main">
        <div className="tp2-trips-toolbar">
          <div className="tp2-title-cluster">
            <h2
              style={{
                fontSize: '27px',
              }}
            >
              我的旅程
            </h2>
          </div>
          <div className="tp2-filters" role="tablist" aria-label="筛选旅程">
            {filters.map(f => (
              <button
                type="button"
                role="tab"
                aria-selected={filter === f}
                key={f}
                onClick={() => {
                  setFilter(f);
                  setTripMenu(null);
                }}
                className={
                  (filter === f ? 'active ' : '') +
                  (f === '出行中'
                    ? 'tp2-filter-traveling'
                    : f === '待出行'
                      ? 'tp2-filter-future'
                      : f === '已结束'
                        ? 'tp2-filter-done'
                        : 'tp2-filter-all')
                }
              >
                {f}
                <span
                  className="tp2-filter-count"
                  style={{
                    fontSize: '14px',
                  }}
                >
                  {getCount(f)}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="tp2-trip-grid">
          <button
            className="tp2-new-card"
            onClick={() => setInfoMessage('新建旅程流程将在下一阶段确定')}
          >
            <span className="tp2-new-card-mountains" aria-hidden="true">
              <svg viewBox="0 0 380 110" preserveAspectRatio="none">
                <path
                  fill="#d6eaff"
                  d="m0 95 35-33 28 23 47-52 45 42 45-26 52 45 41-49 45 34 42-11v42H0z"
                />
                <path
                  fill="#c4e1ff"
                  d="m0 105 52-22 43 14 58-37 48 43 35-30 54 22 41-14 49 27v10H0z"
                />
              </svg>
            </span>
            <span className="tp2-plus-circle">
              <Icon name="plus" size={29} />
            </span>
            <strong>新建旅程</strong>
            <small>从这里，开启下一段旅程</small>
          </button>
          {displayed.map(t => (
            <article className="tp2-trip" key={t.id}>
              <div
                className="tp2-trip-cover"
                style={{
                  backgroundImage: "url('" + t.cover + "')",
                }}
              >
                <Tag status={t.status} />
                <div
                  className="tp2-trip-actions"
                  style={{
                    translate: '0.5px 4px',
                  }}
                >
                  <button
                    className="tp2-more-btn"
                    aria-label={t.title + '操作菜单'}
                    aria-expanded={tripMenu === t.id}
                    onClick={e => {
                      e.stopPropagation();
                      setTripMenu(tripMenu === t.id ? null : t.id);
                      setOpenPanel('none');
                    }}
                  >
                    <Icon name="more" size={18} />
                  </button>
                  {tripMenu === t.id && (
                    <div className="tp2-trip-menu" onClick={e => e.stopPropagation()}>
                      {['重命名', '分享旅程', '删除旅程'].map(action => (
                        <button
                          key={action}
                          onClick={() => {
                            setInfoMessage(action + '交互将在旅程卡片评审中确认');
                            setTripMenu(null);
                          }}
                        >
                          {action}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="tp2-trip-details">
                <h3 title={t.title}>{t.title}</h3>
                <p className="tp2-date">{t.range}</p>
                <div className="tp2-trip-footer">
                  <span className="tp2-region">
                    <Icon name="pin" size={15} />
                    <span title={t.region}>{t.region}</span>
                  </span>
                  <span className="tp2-duration">{t.duration}</span>
                </div>
                <div className="tp2-trip-summary">
                  <span aria-label="旅程总费用">{t.totalCost ?? '总费用待填写'}</span>
                  <span className="tp2-travelers">
                    <Icon name="user" size={14} />
                    {t.travelers === null ? '人数待填写' : t.travelers + '人'}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
        <p className="tp2-bottom-note">每一次出发，都从一个好计划开始。</p>
      </main>
      {infoMessage && (
        <div className="tp2-toast" role="status">
          <span>{infoMessage}</span>
          <button aria-label="关闭提示" onClick={() => setInfoMessage('')}>
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
    </div>
  );
};
