import { markStartup } from './src/startup'
import 'react-native-gesture-handler'
import { registerRootComponent } from 'expo'
import { AppRegistry } from 'react-native'
import App from './App'
import QuickNote from './src/QuickNote'

markStartup('bundle')
AppRegistry.registerComponent('quickNote', () => QuickNote)
registerRootComponent(App)
