import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from '../public/locales/en/translation.json';
import ja from '../public/locales/ja/translation.json';
import zh from '../public/locales/zh/translation.json';
import es from '../public/locales/es/translation.json';

i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        resources: {
            en: {
                translation: en,
            },
            ja: {
                translation: ja,
            },
            zh: {
                translation: zh,
            },
            es: {
                translation: es,
            },
        },
        fallbackLng: 'en',
        interpolation: {
            escapeValue: false,
        },
        detection: {
            order: ['queryString', 'cookie', 'localStorage', 'navigator'],
            caches: ['localStorage'],
        },
    });

export default i18n;
