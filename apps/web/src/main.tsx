import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import './styles/app.css';

// 错误边界包在最外层：App 自己的渲染异常也要接得住，
// 否则连"刷新就能回来"这句提示都显示不出来
createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
);
