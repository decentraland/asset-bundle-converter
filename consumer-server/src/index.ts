import { Lifecycle } from '@well-known-components/interfaces'
import { initComponents } from './components'
import { ensureUlf } from './logic/ensure-ulf'
import { main } from './service'

ensureUlf()

// This file is the program entry point, it only calls the Lifecycle function
Lifecycle.run({ main, initComponents })
