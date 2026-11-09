import { markStartup } from './src/startup'
import 'react-native-gesture-handler'
import { registerRootComponent } from 'expo'
import App from './App'

markStartup('bundle')
registerRootComponent(App)
