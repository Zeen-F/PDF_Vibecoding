// Sending requires a configured provider and the exact configuration revision shown in preview.
export function hasConfirmedTranslationProfile(profile) {
  return profile?.configured === true && ['baidu', 'azure', 'deepl', 'openai-compatible'].includes(profile.provider) && typeof profile.revision === 'string' && /^[a-f0-9]{64}$/.test(profile.revision);
}
