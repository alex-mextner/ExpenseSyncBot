// Scanner tab: native Telegram QR scan, manual URL input, OCR fallback, confirmation card
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { confirmExpenses } from '../api/receipt';
import type { ReceiptItem } from '../api/receipt';
import { startScan, startOcr, streamScan, pollScan, fetchCategories } from '../api/receipt-stream';

// ── Session recovery: save/restore state across page reloads ──────────────────

const STORAGE_KEY = 'scanner_saved_state';

interface SavedState {
	phase: Phase;
	items: ReceiptItem[];
	fileId: string | null;
	currency: string;
	urlInput: string;
	scrollY: number;
	/** Prevents infinite reload loop when reload doesn't refresh initData */
	reloadAttempted: boolean;
	scanId?: string;
	groupId?: number;
	photoPreview?: string;
}

function saveAndReload(state: Omit<SavedState, 'scrollY' | 'reloadAttempted'>): void {
	const saved: SavedState = { ...state, scrollY: window.scrollY, reloadAttempted: true };
	sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
	location.reload();
}

function loadSavedState(): SavedState | null {
	const raw = sessionStorage.getItem(STORAGE_KEY);
	sessionStorage.removeItem(STORAGE_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as SavedState;
	} catch {
		return null;
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Check if error is an expired session that we should try to recover from */
function isExpiredSession(err: unknown): boolean {
	return err instanceof ApiError && err.code === 'INIT_DATA_EXPIRED';
}

/** Map API error codes to user-friendly messages */
function friendlyErrorMessage(err: unknown): string {
	if (err instanceof ApiError) {
		if (err.code === 'INIT_DATA_EXPIRED') return 'Сессия истекла. Закрой и открой Mini App заново.';
		if (err.code === 'INVALID_INIT_DATA') return 'Ошибка авторизации. Закрой и открой Mini App заново.';
		if (err.code === 'FORBIDDEN_GROUP') return 'Нет доступа к этой группе.';
		if (err.code === 'SCAN_FAILED') return 'Не удалось распознать чек. Попробуй ещё раз.';
		if (err.code === 'OCR_FAILED') return 'Не удалось распознать фото. Попробуй другое фото.';
		if (err.code === 'CONFIRM_FAILED') return 'Не удалось сохранить расходы. Попробуй ещё раз.';
		if (err.code === 'PAYLOAD_TOO_LARGE') return 'Фото слишком большое (макс. 2 МБ).';
		if (err.code === 'UNSUPPORTED_MEDIA_TYPE') return 'Поддерживается только JPEG.';
		return err.message;
	}
	if (err instanceof Error) return err.message;
	return 'Неизвестная ошибка';
}

/** Russian numeral declension — local copy because miniapp is a separate Vite build, cannot import from src/utils/ */
function pluralize(n: number, one: string, few: string, many: string): string {
	const abs = Math.abs(n);
	const mod10 = abs % 10;
	const mod100 = abs % 100;
	if (mod100 >= 11 && mod100 <= 19) return many;
	if (mod10 === 1) return one;
	if (mod10 >= 2 && mod10 <= 4) return few;
	return many;
}

type Phase = 'idle' | 'url-input' | 'ocr-input' | 'streaming' | 'confirm' | 'done' | 'error';

/** Stable key for item list rendering — survives reorder but not duplicate name+total */
let itemKeyCounter = 0;
function nextItemKey(item: ReceiptItem): string {
	return `${item.name}-${item.total}-${++itemKeyCounter}`;
}

interface KeyedItem extends ReceiptItem {
	_key: string;
}

function keyItem(item: ReceiptItem): KeyedItem {
	return { ...item, _key: nextItemKey(item) };
}

function keyItems(items: ReceiptItem[]): KeyedItem[] {
	return items.map(keyItem);
}

interface Props {
	groupId: number;
}

export function Scanner({ groupId }: Props) {
	const [phase, setPhase] = useState<Phase>('idle');
	const [items, setItems] = useState<KeyedItem[]>([]);
	const [fileId, setFileId] = useState<string | null>(null);
	const [currency, setCurrency] = useState<string>('');
	const [error, setError] = useState<string>('');
	const [urlInput, setUrlInput] = useState('');
	/** true after a reload attempt — prevents infinite reload loop */
	const [reloadAttempted, setReloadAttempted] = useState(false);
	const [scanId, setScanId] = useState<string | null>(null);
	const [streamUrl, setStreamUrl] = useState<string | null>(null);
	const [photoPreview, setPhotoPreview] = useState<string | null>(null);
	const [isOcrMode, setIsOcrMode] = useState(false);
	const [categories, setCategories] = useState<string[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const cleanupRef = useRef<(() => void) | null>(null);

	// Inject CSS keyframes for streaming animations
	useEffect(() => {
		const id = 'scanner-keyframes';
		if (document.getElementById(id)) return;
		const style = document.createElement('style');
		style.id = id;
		style.textContent = `
			@keyframes scanMove {
				0% { top: 5%; }
				100% { top: 95%; }
			}
			@keyframes pulse {
				0%, 100% { opacity: 1; }
				50% { opacity: 0.4; }
			}
			@keyframes slideIn {
				from { opacity: 0; transform: translateY(8px); }
				to { opacity: 1; transform: translateY(0); }
			}
		`;
		document.head.appendChild(style);
		return () => {
			document.getElementById(id)?.remove();
		};
	}, []);

	// Fetch group categories for combobox
	useEffect(() => {
		fetchCategories(groupId).then(setCategories).catch(() => {});
	}, [groupId]);

	// Cleanup SSE on unmount
	useEffect(() => {
		return () => {
			cleanupRef.current?.();
		};
	}, []);

	// Reconnect to an in-progress scan (session recovery or orphaned scanId)
	async function reconnectToScan(id: string, photo?: string) {
		try {
			const state = await pollScan(id);
			setScanId(id);
			if (photo) setPhotoPreview(photo);

			if (state.phase === 'done') {
				setItems(keyItems(state.items));
				setCurrency(state.currency ?? '');
				setFileId(state.fileId ?? null);
				setPhase('confirm');
				sessionStorage.removeItem('scanner_scanId');
				return;
			}

			if (state.phase === 'error') {
				setError(state.error ?? 'Ошибка сканирования');
				setPhase('error');
				sessionStorage.removeItem('scanner_scanId');
				return;
			}

			// Still processing — set known items, open SSE
			setPhase('streaming');
			setItems(keyItems(state.items));
			if (state.url) setStreamUrl(state.url);
			setIsOcrMode(!!photo);

			const knownCount = state.items.length;
			let sseItemIndex = 0;

			cleanupRef.current = streamScan(id, {
				onUrl: (url) => setStreamUrl(url),
				onItem: (item) => {
					sseItemIndex++;
					if (sseItemIndex <= knownCount) return;
					setItems((prev) => [...prev, keyItem(item)]);
				},
				onDone: (result) => {
					setItems(keyItems(result.items));
					setCurrency(result.currency ?? '');
					setFileId(result.fileId ?? null);
					setPhase('confirm');
					setPhotoPreview(null);
					sessionStorage.removeItem('scanner_scanId');
				},
				onError: (error) => {
					setError(error.message);
					setPhase('error');
					sessionStorage.removeItem('scanner_scanId');
				},
			});
		} catch {
			sessionStorage.removeItem('scanner_scanId');
			setPhase('idle');
		}
	}

	// Restore state from sessionStorage after a session-recovery reload
	useEffect(() => {
		const saved = loadSavedState();
		if (!saved) {
			const orphanedScanId = sessionStorage.getItem('scanner_scanId');
			if (orphanedScanId) {
				reconnectToScan(orphanedScanId);
			}
			return;
		}

		setReloadAttempted(saved.reloadAttempted);
		setUrlInput(saved.urlInput);
		setCurrency(saved.currency);
		setFileId(saved.fileId);

		if (saved.scanId) {
			reconnectToScan(saved.scanId, saved.photoPreview);
		} else {
			setItems(keyItems(saved.items));
			setPhase(saved.phase);
			requestAnimationFrame(() => window.scrollTo(0, saved.scrollY));
		}
	}, []);

	/** Try reload to get fresh initData, or show error if already tried */
	const handleExpiredSession = useCallback(
		(currentPhase: Phase) => {
			if (reloadAttempted) {
				// Reload didn't help — initData is still stale, show manual instruction
				setError('Сессия истекла. Закрой и открой Mini App заново.');
				setPhase('error');
				return;
			}
			cleanupRef.current?.();
			saveAndReload({
				phase: currentPhase,
				items,
				fileId,
				currency,
				urlInput,
				scanId: scanId ?? undefined,
				groupId,
				photoPreview: photoPreview ?? undefined,
			});
		},
		[reloadAttempted, items, fileId, currency, urlInput, scanId, photoPreview, groupId],
	);

	const handleQRDetected = useCallback(
		async (qrData: string) => {
			window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
			setPhase('streaming');
			setIsOcrMode(false);
			setItems([]);
			setStreamUrl(null);

			try {
				const id = await startScan(groupId, qrData);
				setScanId(id);
				sessionStorage.setItem('scanner_scanId', id);

				cleanupRef.current = streamScan(id, {
					onUrl: (url) => setStreamUrl(url),
					onItem: (item) => setItems((prev) => [...prev, keyItem(item)]),
					onDone: (result) => {
						setItems(keyItems(result.items));
						setCurrency(result.currency ?? '');
						setFileId(result.fileId ?? null);
						setPhase('confirm');
						sessionStorage.removeItem('scanner_scanId');
					},
					onError: (error) => {
						if (error.code === 'INIT_DATA_EXPIRED') {
							handleExpiredSession('streaming');
							return;
						}
						setError(friendlyErrorMessage(new ApiError(0, error.message, error.code)));
						setPhase('error');
						sessionStorage.removeItem('scanner_scanId');
					},
				});
			} catch (e) {
				if (isExpiredSession(e)) {
					handleExpiredSession('idle');
					return;
				}
				setError(friendlyErrorMessage(e));
				setPhase('error');
			}
		},
		[groupId, handleExpiredSession],
	);

	const openNativeQRScanner = useCallback(() => {
		const tg = window.Telegram?.WebApp;
		if (!tg?.showScanQrPopup) {
			setError('QR-сканер недоступен в этой версии Telegram');
			setPhase('error');
			return;
		}

		tg.showScanQrPopup({ text: 'Наведи на QR-код чека' }, (text: string) => {
			handleQRDetected(text).catch((err: unknown) => {
				setError(friendlyErrorMessage(err));
				setPhase('error');
			});
			return true;
		});
	}, [handleQRDetected]);

	const handleURLSubmit = useCallback(async () => {
		if (!urlInput.trim()) return;
		await handleQRDetected(urlInput.trim());
	}, [urlInput, handleQRDetected]);

	const handleURLKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				handleURLSubmit();
			}
		},
		[handleURLSubmit],
	);

	const handleFileUpload = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file) return;
			setPhase('streaming');
			setIsOcrMode(true);
			setItems([]);

			const reader = new FileReader();
			reader.onload = () => setPhotoPreview(reader.result as string);
			reader.readAsDataURL(file);

			try {
				const id = await startOcr(groupId, file);
				setScanId(id);
				sessionStorage.setItem('scanner_scanId', id);

				cleanupRef.current = streamScan(id, {
					onItem: (item) => setItems((prev) => [...prev, keyItem(item)]),
					onDone: (result) => {
						setItems(keyItems(result.items));
						setCurrency(result.currency ?? '');
						setFileId(result.fileId ?? null);
						setPhase('confirm');
						setPhotoPreview(null);
						sessionStorage.removeItem('scanner_scanId');
					},
					onError: (error) => {
						if (error.code === 'INIT_DATA_EXPIRED') {
							handleExpiredSession('streaming');
							return;
						}
						setError(friendlyErrorMessage(new ApiError(0, error.message, error.code)));
						setPhase('error');
						sessionStorage.removeItem('scanner_scanId');
					},
				});
			} catch (uploadErr) {
				if (isExpiredSession(uploadErr)) {
					handleExpiredSession('ocr-input');
					return;
				}
				setError(friendlyErrorMessage(uploadErr));
				setPhase('error');
			}
		},
		[groupId, handleExpiredSession],
	);

	const handleConfirm = useCallback(async () => {
		setSubmitting(true);
		try {
			await confirmExpenses(
				groupId,
				items.map((it) => ({
					name: it.name,
					qty: it.qty,
					price: it.price,
					total: it.total,
					category: it.category,
					currency: currency || 'RSD',
				})),
				fileId,
			);
			setSubmitting(false);
			setPhase('done');
		} catch (confirmErr) {
			setSubmitting(false);
			if (isExpiredSession(confirmErr)) {
				handleExpiredSession('confirm');
				return;
			}
			setError(friendlyErrorMessage(confirmErr));
			setPhase('error');
		}
	}, [groupId, items, fileId, currency, handleExpiredSession]);

	const handleItemChange = (i: number, field: keyof ReceiptItem, value: string | number) => {
		setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [field]: value } : it)));
	};

	const handleRemoveItem = (i: number) => {
		setItems((prev) => prev.filter((_, idx) => idx !== i));
	};

	const resetToIdle = () => {
		cleanupRef.current?.();
		cleanupRef.current = null;
		setItems([]);
		setFileId(null);
		setCurrency('');
		setError('');
		setUrlInput('');
		setScanId(null);
		setStreamUrl(null);
		setPhotoPreview(null);
		setIsOcrMode(false);
		setPhase('idle');
		sessionStorage.removeItem('scanner_scanId');
	};

	// --- Render phases ---

	if (phase === 'done') {
		return (
			<div style={{ ...pageStyle, textAlign: 'center' }}>
				<div style={{ fontSize: 48 }}>✅</div>
				<div style={{ fontSize: 18, marginTop: 12 }}>Расходы записаны!</div>
				<button type="button" onClick={resetToIdle} style={btnStyle}>
					Сканировать ещё
				</button>
			</div>
		);
	}

	if (phase === 'error') {
		return (
			<div style={pageStyle}>
				<div style={{ color: '#F44336', marginBottom: 12, fontSize: 15, lineHeight: 1.4 }}>
					{error}
				</div>
				<button type="button" onClick={resetToIdle} style={btnStyle}>
					Повторить
				</button>
			</div>
		);
	}

	if (phase === 'streaming') {
		return (
			<div style={pageStyle}>
				{/* OCR: photo with scan line */}
				{isOcrMode && photoPreview && (
					<div style={scanOverlayStyle}>
						<img
							src={photoPreview}
							alt="Receipt"
							style={{
								width: '100%',
								borderRadius: 8,
								maxHeight: items.length > 0 ? 120 : 240,
								objectFit: 'cover',
								transition: 'max-height 0.3s ease',
							}}
						/>
						{items.length === 0 && <div style={scanLineStyle} />}
					</div>
				)}

				{/* QR: shortened URL */}
				{!isOcrMode && streamUrl && (
					<div
						style={{
							fontSize: 13,
							color: 'var(--tg-theme-hint-color, #999)',
							marginBottom: 12,
							wordBreak: 'break-all' as const,
						}}
					>
						🔗 {streamUrl}
					</div>
				)}

				{/* Status label with pulsing dot */}
				<div
					style={{
						fontSize: 15,
						marginBottom: 12,
						display: 'flex',
						alignItems: 'center',
						gap: 8,
					}}
				>
					<span style={pulsingDotStyle} />
					{items.length === 0
						? isOcrMode
							? 'Сканируем чек...'
							: 'Загружаем чек...'
						: 'Распознаём позиции...'}
				</div>

				{/* Items appearing one by one */}
				{items.map((item) => (
					<div key={item._key} style={{ ...streamingItemStyle, animation: 'slideIn 0.3s ease' }}>
						<div style={{ display: 'flex', justifyContent: 'space-between' }}>
							<span
								style={{
									flex: 1,
									minWidth: 0,
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap' as const,
								}}
							>
								{item.name}
							</span>
							<span
								style={{ fontWeight: 600, whiteSpace: 'nowrap' as const, marginLeft: 8 }}
							>
								{item.total.toLocaleString('ru-RU')}
							</span>
						</div>
						{item.qty > 1 && (
							<div style={{ fontSize: 13, color: 'var(--tg-theme-hint-color, #999)' }}>
								{item.qty} × {item.price.toLocaleString('ru-RU')}
							</div>
						)}
					</div>
				))}

				{/* Skeleton placeholder */}
				<div style={skeletonStyle}>
					<div style={skeletonBarStyle} />
				</div>

				<button
					type="button"
					onClick={() => {
						cleanupRef.current?.();
						resetToIdle();
					}}
					style={{ ...secondaryBtnStyle, marginTop: 16 }}
				>
					Отмена
				</button>
			</div>
		);
	}

	if (phase === 'confirm') {
		const total = items.reduce((sum, it) => sum + it.total, 0);

		return (
			<div style={pageStyle}>
				<h3 style={{ margin: '0 0 4px' }}>Подтверди расходы</h3>
				<div
					style={{
						fontSize: 14,
						color: 'var(--tg-theme-hint-color, #999)',
						marginBottom: 16,
					}}
				>
					{items.length} {pluralize(items.length, 'позиция', 'позиции', 'позиций')} ·{' '}
					{total.toLocaleString('ru-RU')} {currency}
				</div>

				<datalist id="category-options">
					{categories.map((cat) => (
						<option key={cat} value={cat} />
					))}
				</datalist>

				{items.map((item, i) => (
					<div
						key={item._key}
						style={{
							border: '1px solid var(--tg-theme-hint-color, rgba(128,128,128,0.2))',
							borderRadius: 10,
							padding: '10px 12px',
							marginBottom: 8,
						}}
					>
						<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
							<input
								value={item.name}
								onChange={(e) => handleItemChange(i, 'name', e.target.value)}
								style={{ ...inputStyle, flex: 1, padding: '8px 10px', fontSize: 15 }}
							/>
							<span
								style={{ fontWeight: 600, whiteSpace: 'nowrap' as const, fontSize: 15 }}
							>
								{item.total.toLocaleString('ru-RU')}
							</span>
							<button
								type="button"
								onClick={() => handleRemoveItem(i)}
								style={{
									background: 'none',
									border: 'none',
									color: 'var(--tg-theme-hint-color, #999)',
									fontSize: 20,
									cursor: 'pointer',
									padding: '0 4px',
									lineHeight: 1,
								}}
							>
								×
							</button>
						</div>
						<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
							<input
								list="category-options"
								value={item.category}
								onChange={(e) => handleItemChange(i, 'category', e.target.value)}
								placeholder="Категория"
								style={{
									...inputStyle,
									flex: 1,
									padding: '6px 10px',
									fontSize: 14,
									color: 'var(--tg-theme-hint-color, #777)',
								}}
							/>
							{item.qty > 1 && (
								<span
									style={{
										fontSize: 13,
										color: 'var(--tg-theme-hint-color, #999)',
										whiteSpace: 'nowrap' as const,
									}}
								>
									{item.qty} × {item.price.toLocaleString('ru-RU')}
								</span>
							)}
						</div>
					</div>
				))}

				{items.length > 0 && (
					<button
						type="button"
						onClick={handleConfirm}
						disabled={submitting}
						style={{ ...btnStyle, marginTop: 8, opacity: submitting ? 0.6 : 1 }}
					>
						{submitting
							? 'Сохраняем...'
							: `Записать ${items.length} ${pluralize(items.length, 'расход', 'расхода', 'расходов')}`}
					</button>
				)}
				<button
					type="button"
					onClick={resetToIdle}
					disabled={submitting}
					style={{ ...secondaryBtnStyle, marginTop: 8, opacity: submitting ? 0.6 : 1 }}
				>
					Отмена
				</button>
			</div>
		);
	}

	if (phase === 'url-input') {
		return (
			<div style={pageStyle}>
				<h3 style={{ margin: '0 0 12px' }}>Вставь ссылку из QR</h3>
				<input
					value={urlInput}
					onChange={(e) => setUrlInput(e.target.value)}
					onKeyDown={handleURLKeyDown}
					placeholder="https://..."
					style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginBottom: 12 }}
					autoFocus
				/>
				<button type="button" onClick={handleURLSubmit} style={btnStyle}>
					Отправить
				</button>
				<button
					type="button"
					onClick={() => setPhase('idle')}
					style={{ ...secondaryBtnStyle, marginTop: 8 }}
				>
					Назад
				</button>
			</div>
		);
	}

	if (phase === 'ocr-input') {
		return (
			<div style={pageStyle}>
				<h3 style={{ margin: '0 0 12px' }}>Сфотографируй чек</h3>
				<label style={{ ...btnStyle, display: 'block', textAlign: 'center', cursor: 'pointer' }}>
					📷 Выбрать фото
					<input
						type="file"
						accept="image/*"
						capture="environment"
						onChange={handleFileUpload}
						style={{ display: 'none' }}
					/>
				</label>
				<button
					type="button"
					onClick={() => setPhase('idle')}
					style={{ ...secondaryBtnStyle, marginTop: 8 }}
				>
					Назад
				</button>
			</div>
		);
	}

	// Default: idle phase — action buttons
	return (
		<div style={pageStyle}>
			<h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 600 }}>Сканер чеков</h2>
			<p
				style={{
					margin: '0 0 24px',
					fontSize: 14,
					color: 'var(--tg-theme-hint-color, #999)',
					lineHeight: 1.4,
				}}
			>
				Сканируй QR-код, вставь ссылку или сфотографируй чек
			</p>

			<button type="button" onClick={openNativeQRScanner} style={btnStyle}>
				📷 Сканировать QR-код
			</button>

			<button
				type="button"
				onClick={() => setPhase('url-input')}
				style={{ ...secondaryBtnStyle, marginTop: 10 }}
			>
				🔗 Вставить ссылку
			</button>

			<button
				type="button"
				onClick={() => setPhase('ocr-input')}
				style={{ ...secondaryBtnStyle, marginTop: 10 }}
			>
				📄 Фото чека (OCR)
			</button>
		</div>
	);
}

const pageStyle: React.CSSProperties = {
	padding: 24,
	color: 'var(--tg-theme-text-color, #000)',
	backgroundColor: 'var(--tg-theme-bg-color, #fff)',
	minHeight: '100dvh',
	boxSizing: 'border-box',
};

const btnStyle: React.CSSProperties = {
	display: 'block',
	width: '100%',
	padding: '14px 16px',
	background: 'var(--tg-theme-button-color, #2196F3)',
	color: 'var(--tg-theme-button-text-color, #fff)',
	border: 'none',
	borderRadius: 12,
	fontSize: 16,
	fontWeight: 600,
	cursor: 'pointer',
};

const secondaryBtnStyle: React.CSSProperties = {
	display: 'block',
	width: '100%',
	padding: '14px 16px',
	background: 'var(--tg-theme-secondary-bg-color, rgba(128,128,128,0.12))',
	color: 'var(--tg-theme-text-color, inherit)',
	border: 'none',
	borderRadius: 12,
	fontSize: 16,
	fontWeight: 500,
	cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
	padding: '12px 14px',
	border: '1px solid var(--tg-theme-hint-color, rgba(128,128,128,0.3))',
	borderRadius: 10,
	fontSize: 16,
	background: 'var(--tg-theme-secondary-bg-color, rgba(128,128,128,0.08))',
	color: 'var(--tg-theme-text-color, #000)',
};

const scanOverlayStyle: React.CSSProperties = {
	position: 'relative',
	overflow: 'hidden',
	borderRadius: 8,
	marginBottom: 16,
};

const scanLineStyle: React.CSSProperties = {
	position: 'absolute',
	left: 0,
	right: 0,
	height: 3,
	background:
		'linear-gradient(to right, transparent 0%, #4CAF50 30%, #4CAF50 70%, transparent 100%)',
	boxShadow: '0 0 8px rgba(76, 175, 80, 0.6)',
	animation: 'scanMove 2.5s ease-in-out infinite alternate',
	top: '5%',
};

const pulsingDotStyle: React.CSSProperties = {
	width: 8,
	height: 8,
	borderRadius: '50%',
	background: 'var(--tg-theme-button-color, #2196F3)',
	animation: 'pulse 1.5s ease-in-out infinite',
	flexShrink: 0,
};

const streamingItemStyle: React.CSSProperties = {
	border: '1px solid var(--tg-theme-hint-color, rgba(128,128,128,0.2))',
	borderRadius: 8,
	padding: 10,
	marginBottom: 6,
};

const skeletonStyle: React.CSSProperties = {
	border: '1px dashed var(--tg-theme-hint-color, rgba(128,128,128,0.2))',
	borderRadius: 8,
	padding: 14,
	marginBottom: 6,
};

const skeletonBarStyle: React.CSSProperties = {
	height: 14,
	borderRadius: 4,
	background: 'var(--tg-theme-hint-color, rgba(128,128,128,0.15))',
	animation: 'pulse 1.5s ease-in-out infinite',
	width: '60%',
};
