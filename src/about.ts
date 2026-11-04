import appConfig from '../app.json'

export const appVersion: string = appConfig.expo.version
export const appCommit = process.env.EXPO_PUBLIC_TYPO_COMMIT || null
export const repositoryUrl = 'https://github.com/DontBlameMeDev/typo'
export const issuesUrl = `${repositoryUrl}/issues`
export const commitUrl = (commit: string) => `${repositoryUrl}/commit/${commit}`
