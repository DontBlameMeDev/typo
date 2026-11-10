import { requireOptionalNativeModule } from 'expo-modules-core'

type TypoQuickNoteModule = {
  finish(): void
}

const nativeModule = requireOptionalNativeModule<TypoQuickNoteModule>('TypoQuickNote')

export function finishQuickNote(): void {
  nativeModule?.finish()
}
