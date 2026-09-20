// Use the same system theme and token selectors as the app before first paint.
const preference = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', preference.matches);
applyTheme();
preference.addEventListener('change', applyTheme);
