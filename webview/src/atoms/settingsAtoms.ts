import { atom } from 'jotai';
import { DEFAULT_AI_SETTINGS, type AppSettings } from '../config/app';

export const settingsAtom = atom<AppSettings>({ ...DEFAULT_AI_SETTINGS });
