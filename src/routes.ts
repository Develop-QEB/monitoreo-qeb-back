import { Router } from 'express'
import { authRouter } from './modules/auth'
import { usersRouter } from './modules/users'
import { auditRouter } from './modules/audit'
import { qebRouter } from './modules/qeb'
import { infraRouter } from './modules/infra'
import { monitorFrontendRouter } from './modules/monitorFrontend'

export const apiRouter: Router = Router()

apiRouter.use('/auth', authRouter)
apiRouter.use('/users', usersRouter)
apiRouter.use('/audit', auditRouter)
apiRouter.use('/qeb', qebRouter)
apiRouter.use('/infra', infraRouter)
apiRouter.use('/monitor', monitorFrontendRouter)
