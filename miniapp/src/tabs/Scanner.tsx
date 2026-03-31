// Scanner tab: ZXing live QR scan, OCR fallback, confirmation card
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';
import { confirmExpenses, scanQR, uploadOCR } from '../api/receipt';
import type { ReceiptItem } from '../api/receipt';

type Phase = 'scanning' | 'url-input' | 'ocr-input' | 'loading' | 'confirm' | 'done' | 'error';

interface Props {
	groupId: number;
}

export function Scanner({ groupId }: Props) {
	const [phase, setPhase] = useState<Phase>('scanning');
	const [items, setItems] = useState<ReceiptItem[]>([]);
	const [fileId, setFileId] = useState<string | null>(null);
	const [currency, setCurrency] = useState<string>('');
	const [error, setError] = useState<string>('');
	const [urlInput, setUrlInput] = useState('');
	const videoRef = useRef<HTMLVideoElement>(null);
	const readerRef = useRef<BrowserQRCodeReader | null>(null);
	const controlsRef = useRef<{ stop: () => void } | null>(null);

	// Start QR scanning
	useEffect(() => {
		if (phase !== 'scanning') return;

		const reader = new BrowserQRCodeReader();
		readerRef.current = reader;

		reader
			.decodeFromVideoDevice(undefined, videoRef.current!, (result, err, controls) => {
				controlsRef.current = controls;
				if (result) {
					controls.stop();
					handleQRDetected(result.getText());
				}
				// suppress scan errors (no QR found yet)
				void err;
			})
			.catch((e: unknown) => {
				setError(`Камера недоступна: ${e instanceof Error ? e.message : 'unknown'}`);
				setPhase('error');
			});

		return () => {
			controlsRef.current?.stop();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [phase === 'scanning']);

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
		[groupId]
	);

	const handleURLSubmit = useCallback(async () => {
		if (!urlInput.trim()) return;
		await handleQRDetected(urlInput.trim());
	}, [urlInput, handleQRDetected]);

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
			} catch (e) {
				setError(e instanceof Error ? e.message : 'Ошибка OCR');
				setPhase('error');
			}
		},
		[groupId]
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
				fileId
			);
			setPhase('done');
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Ошибка сохранения');
			setPhase('error');
		}
	}, [groupId, items, fileId, currency]);

	const handleItemChange = (i: number, field: keyof ReceiptItem, value: string | number) => {
		setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [field]: value } : it)));
	};

	const handleRemoveItem = (i: number) => {
		setItems((prev) => prev.filter((_, idx) => idx !== i));
	};

	// --- Render phases ---

	if (phase === 'done') {
		return (
			<div style={{ padding: 24, textAlign: 'center' }}>
				<div style={{ fontSize: 48 }}>✅</div>
				<div style={{ fontSize: 18, marginTop: 12 }}>Расходы записаны!</div>
				<button
					onClick={() => {
						setItems([]);
						setFileId(null);
						setCurrency('');
						setPhase('scanning');
					}}
					style={btnStyle}
				>
					Сканировать ещё
				</button>
			</div>
		);
	}

	if (phase === 'error') {
		return (
			<div style={{ padding: 24 }}>
				<div style={{ color: '#F44336', marginBottom: 12 }}>{error}</div>
				<button
					onClick={() => {
						setError('');
						setPhase('scanning');
					}}
					style={btnStyle}
				>
					Повторить
				</button>
			</div>
		);
	}

	if (phase === 'loading') {
		return (
			<div style={{ padding: 24, textAlign: 'center', marginTop: 80 }}>
				<div>Обрабатываем чек…</div>
			</div>
		);
	}

	if (phase === 'confirm') {
		return (
			<div style={{ padding: 16 }}>
				<h3 style={{ margin: '0 0 12px' }}>Подтверди расходы</h3>
				{items.map((item, i) => (
					<div
						key={i}
						style={{
							border: '1px solid rgba(128,128,128,0.2)',
							borderRadius: 8,
							padding: 10,
							marginBottom: 8,
						}}
					>
						<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
							<input
								value={item.name}
								onChange={(e) => handleItemChange(i, 'name', e.target.value)}
								style={inputStyle}
							/>
							<button
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
					<button onClick={handleConfirm} style={{ ...btnStyle, marginTop: 8 }}>
						Записать {items.length} расход{items.length === 1 ? '' : 'а'}
					</button>
				)}
				<button
					onClick={() => setPhase('scanning')}
					style={{ ...btnStyle, background: 'rgba(128,128,128,0.15)', color: 'inherit', marginTop: 8 }}
				>
					Отмена
				</button>
			</div>
		);
	}

	if (phase === 'url-input') {
		return (
			<div style={{ padding: 16 }}>
				<h3 style={{ margin: '0 0 12px' }}>Вставь ссылку из QR</h3>
				<input
					value={urlInput}
					onChange={(e) => setUrlInput(e.target.value)}
					placeholder="https://..."
					style={{ ...inputStyle, width: '100%', marginBottom: 8 }}
					autoFocus
				/>
				<button onClick={handleURLSubmit} style={btnStyle}>
					Отправить
				</button>
				<button
					onClick={() => setPhase('scanning')}
					style={{ ...btnStyle, background: 'rgba(128,128,128,0.15)', color: 'inherit', marginTop: 8 }}
				>
					Назад
				</button>
			</div>
		);
	}

	if (phase === 'ocr-input') {
		return (
			<div style={{ padding: 16 }}>
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
					onClick={() => setPhase('scanning')}
					style={{ ...btnStyle, background: 'rgba(128,128,128,0.15)', color: 'inherit', marginTop: 8 }}
				>
					Назад
				</button>
			</div>
		);
	}

	// Default: scanning phase
	return (
		<div style={{ position: 'relative', height: '100dvh', overflow: 'hidden', background: '#000' }}>
			{/* Live video */}
			<video
				ref={videoRef}
				style={{ width: '100%', height: '100%', objectFit: 'cover' }}
				playsInline
				muted
				autoPlay
			/>

			{/* Viewfinder overlay */}
			<div
				style={{
					position: 'absolute',
					inset: 0,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					pointerEvents: 'none',
				}}
			>
				<div
					style={{
						width: 240,
						height: 240,
						border: '2px solid rgba(255,255,255,0.8)',
						borderRadius: 16,
						boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)',
						position: 'relative',
					}}
				>
					{/* Animated scan line */}
					<ScanLine />
				</div>
				<div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, marginTop: 16 }}>
					Наведи камеру на QR-код чека
				</div>
			</div>

			{/* Bottom buttons */}
			<div
				style={{
					position: 'absolute',
					bottom: 40,
					left: 0,
					right: 0,
					display: 'flex',
					gap: 12,
					justifyContent: 'center',
					padding: '0 16px',
				}}
			>
				<button onClick={() => setPhase('url-input')} style={overlayBtnStyle}>
					🔗 Ссылка
				</button>
				<button onClick={() => setPhase('ocr-input')} style={overlayBtnStyle}>
					📷 Фото чека
				</button>
			</div>
		</div>
	);
}

function ScanLine() {
	const [pos, setPos] = useState(0);
	useEffect(() => {
		let frame: number;
		let start: number | null = null;
		const animate = (ts: number) => {
			if (!start) start = ts;
			const t = ((ts - start) % 2000) / 2000; // 0-1 over 2s
			setPos(t < 0.5 ? t * 2 : 2 - t * 2); // ping-pong 0→1→0
			frame = requestAnimationFrame(animate);
		};
		frame = requestAnimationFrame(animate);
		return () => cancelAnimationFrame(frame);
	}, []);
	return (
		<div
			style={{
				position: 'absolute',
				left: 8,
				right: 8,
				top: `${pos * 90 + 5}%`,
				height: 2,
				background: 'rgba(33,150,243,0.9)',
				boxShadow: '0 0 8px rgba(33,150,243,0.7)',
				transition: 'top 0.05s linear',
			}}
		/>
	);
}

const btnStyle: React.CSSProperties = {
	display: 'block',
	width: '100%',
	padding: '12px 16px',
	background: '#2196F3',
	color: '#fff',
	border: 'none',
	borderRadius: 10,
	fontSize: 15,
	fontWeight: 600,
	cursor: 'pointer',
};

const overlayBtnStyle: React.CSSProperties = {
	flex: 1,
	padding: '10px 12px',
	background: 'rgba(255,255,255,0.15)',
	backdropFilter: 'blur(8px)',
	color: '#fff',
	border: '1px solid rgba(255,255,255,0.3)',
	borderRadius: 10,
	fontSize: 14,
	fontWeight: 500,
	cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
	padding: '6px 10px',
	border: '1px solid rgba(128,128,128,0.3)',
	borderRadius: 6,
	fontSize: 14,
	background: 'transparent',
	color: 'inherit',
};
