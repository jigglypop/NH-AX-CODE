import { atom } from 'jotai';

export const isConnectedAtom = atom<boolean | null>(null);
export const hasCheckedConnectionAtom = atom<boolean>(false);
