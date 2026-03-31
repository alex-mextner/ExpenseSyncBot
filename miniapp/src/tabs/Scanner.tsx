// Scanner tab: native Telegram QR scan, manual URL input, OCR fallback, confirmation card
import React, { useCallback, useState } from 'react';
import { confirmExpenses, scanQR, uploadOCR } from '../api/receipt';
import type { ReceiptItem } from '../api/receipt';

/** Russian numeral declension — picks correct noun form for a given count */
function pluralize(n: number, one: string, few: string, many: string): string {
	const abs = Math.abs(n);
	const mod10 = abs % 10;
	const mod100 = abs % 100;
	if (mod100 >= 11 && mod100 <= 19) return many;
	if (mod10 === 1) return one;
	if (mod10 >= 2 && mod10 <= 4) return few;
	return many;
}

type Phase = 'idle' | 'url-input' | 'ocr-input' | 'loading' | 'confirm' | 'done' | 'error';

interface Props {
	groupId: number;
}

export function Scanner({ groupId }: Props) {
	const [phase, setPhase] = useState<Phase>('idle');
	const [items, setItems] = useState<ReceiptItem[]>([]);
	const [fileId, setFileId] = useState<string | null>(null);
	const [currency, setCurrency] = useState<string>('');
	const [error, setError] = useState<string>('');
	const [urlInput, setUrlInput] = useState('');

	const handleQRDetected = useCallback(
		async (qrData: string) => {
			window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
			setPhase('loading');
			try {
				const result = await scanQR(groupId, qrData);
				setItems(result.items);
				setCurrency(result.currency ?? '');
				setPhase('confirm');
			} catch (e) {
				setError(e instanceof Error ? e.message : 'Ошибка сканирования');
				setPhase('error');
			}
		},
		[groupId],
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
				setError(err instanceof Error ? err.message : 'Ошибка сканирования');
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
			setPhase('loading');
			try {
				const result = await uploadOCR(groupId, file);
				setItems(result.items);
				setFileId(result.file_id);
				setCurrency(result.currency ?? '');
				setPhase('confirm');
			} catch (uploadErr) {
				setError(uploadErr instanceof Error ? uploadErr.message : 'Ошибка OCR');
				setPhase('error');
			}
		},
		[groupId],
	);

	const handleConfirm = useCallback(async () => {
		setPhase('loading');
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
			setPhase('done');
		} catch (confirmErr) {
			setError(confirmErr instanceof Error ? confirmErr.message : 'Ошибка сохранения');
			setPhase('error');
		}
	}, [groupId, items, fileId, currency]);

	const handleItemChange = (i: number, field: keyof ReceiptItem, value: string | number) => {
		setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [field]: value } : it)));
	};

	const handleRemoveItem = (i: number) => {
		setItems((prev) => prev.filter((_, idx) => idx !== i));
	};

	const resetToIdle = () => {
		setItems([]);
		setFileId(null);
		setCurrency('');
		setError('');
		setUrlInput('');
		setPhase('idle');
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

	if (phase === 'loading') {
		return (
			<div style={{ ...pageStyle, textAlign: 'center', paddingTop: 80 }}>
				<div>Обрабатываем чек…</div>
			</div>
		);
	}

	if (phase === 'confirm') {
		return (
			<div style={pageStyle}>
				<h3 style={{ margin: '0 0 12px' }}>Подтверди расходы</h3>
				{items.map((item, i) => (
					<div
						key={i}
						style={{
							border: '1px solid var(--tg-theme-hint-color, rgba(128,128,128,0.3))',
							borderRadius: 8,
							padding: 10,
							marginBottom: 8,
						}}
					>
						<div
							style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
						>
							<input
								value={item.name}
								onChange={(e) => handleItemChange(i, 'name', e.target.value)}
								style={inputStyle}
							/>
							<button
								type="button"
								onClick={() => handleRemoveItem(i)}
								style={{
									background: 'none',
									border: 'none',
									color: '#F44336',
									fontSize: 18,
									cursor: 'pointer',
								}}
							>
								×
							</button>
						</div>
						<div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
							<input
								value={item.category}
								onChange={(e) => handleItemChange(i, 'category', e.target.value)}
								placeholder="Категория"
								style={{ ...inputStyle, flex: 1 }}
							/>
							<span style={{ alignSelf: 'center', fontWeight: 600 }}>
								{item.total.toLocaleString('ru-RU')} {currency}
							</span>
						</div>
					</div>
				))}
				{items.length > 0 && (
					<button type="button" onClick={handleConfirm} style={{ ...btnStyle, marginTop: 8 }}>
						Записать {items.length} {pluralize(items.length, 'расход', 'расхода', 'расходов')}
					</button>
				)}
				<button type="button" onClick={resetToIdle} style={{ ...secondaryBtnStyle, marginTop: 8 }}>
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
