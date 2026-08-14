import manifest from './art-manifest.json';

type Manifest = {
	character: Record<string, string | null>;
	card: Record<string, string | null>;
};

const m = manifest as Manifest;

export function generalArt(id: string): string | undefined {
	return m.character?.[id] ?? undefined;
}

/**
 * 火杀/雷杀在素材里没有独立卡面（原作就是【杀】加个属性角标），
 * 这里回落到【杀】的图，属性由 UI 上的角标表达。
 */
const CARD_ART_FALLBACK: Record<string, string> = {
	huosha: 'sha',
	leisha: 'sha',
};

export function cardArt(name: string): string | undefined {
	return m.card?.[name] ?? m.card?.[CARD_ART_FALLBACK[name] ?? ''] ?? undefined;
}

export const SUIT_SYMBOL: Record<string, string> = {
	heart: '♥',
	diamond: '♦',
	spade: '♠',
	club: '♣',
};

export function rankText(n: number): string {
	return n === 1 ? 'A' : n === 11 ? 'J' : n === 12 ? 'Q' : n === 13 ? 'K' : String(n);
}
