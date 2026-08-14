import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 渲染异常兜底。
 *
 * 没有它的时候，任何一个渲染错误（比如某张牌的 id 不在 `view.cards` 里）会白屏整局。
 * 而这个游戏的真实状态全在服务端，**刷新就能完整回来** —— 玩家只是不知道该刷新，
 * 会以为游戏崩了然后放弃。所以兜底界面的核心不是好看，是告诉他"刷新就好"。
 *
 * 注意错误边界只接得住**渲染期**的异常。WebSocket 消息处理里的抛错走的是
 * 事件回调，到不了这里，那条路单独在 store.ts 的 onmessage 里兜。
 */

interface Props {
	children: ReactNode;
}

interface State {
	error?: Error;
	/** 同一个错误反复出现，说明刷新也救不回来，得给一条退路 */
	count: number;
}

export class ErrorBoundary extends Component<Props, State> {
	state: State = { count: 0 };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// 留在控制台，方便玩家截图给我们；也方便自己复现时直接看栈
		console.error('渲染异常', error, info.componentStack);
		this.setState((s) => ({ count: s.count + 1 }));
	}

	private retry = (): void => {
		// 不清房间码：刷新后 App 会用 localStorage 里的房间自动接回牌局
		location.reload();
	};

	private leave = (): void => {
		localStorage.removeItem('sgs.room');
		location.href = '/';
	};

	render(): ReactNode {
		const { error, count } = this.state;
		if (!error) return this.props.children;

		return (
			<div className="lobby">
				<div className="lobby__panel">
					<div className="lobby__title" style={{ fontSize: '4vmin' }}>
						出了点问题
					</div>
					<div style={{ fontSize: '2vmin', color: 'var(--paper-200)', margin: '2vmin 0', lineHeight: 1.7 }}>
						界面出错了，但<b style={{ color: 'var(--gold-100)' }}>你的牌局还在服务器上</b>——
						<br />
						刷新就能回到刚才那一步，不会掉出去。
					</div>

					<div
						style={{
							fontSize: '1.5vmin',
							color: 'var(--gold-400)',
							background: 'rgba(15,13,11,0.8)',
							border: '0.12vmin solid rgba(201,162,39,0.3)',
							borderRadius: '0.4vmin',
							padding: '1vmin',
							margin: '1.5vmin 0',
							textAlign: 'left',
							wordBreak: 'break-all',
							maxHeight: '14vmin',
							overflow: 'auto',
						}}
					>
						{error.message || String(error)}
					</div>

					<div className="btn-row" style={{ justifyContent: 'center' }}>
						<button className="btn" onClick={this.retry}>
							刷新回到牌局
						</button>
						<button className="btn ghost" onClick={this.leave}>
							退出房间
						</button>
					</div>

					{count > 1 && (
						<div style={{ fontSize: '1.6vmin', color: '#e0554a', marginTop: '1.5vmin' }}>
							已经连着出错 {count} 次，刷新可能救不回来。
							<br />
							把上面那段错误信息截图发出来，然后点「退出房间」。
						</div>
					)}
				</div>
			</div>
		);
	}
}
