import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard, AuthService } from "./auth/auth";
import { CompetitionsController } from "./competitions/competitions.controller";
import { CompetitionsService } from "./competitions/competitions.service";
import { JudgesController } from "./competitions/judges.controller";
import { APP_CONFIG, type AppConfig } from "./config";
import { DbModule } from "./db/db.module";
import { LiveGateway } from "./live/live.gateway";
import { PerformancesController } from "./performances/performances.controller";
import { PerformancesService } from "./performances/performances.service";
import { RelayPublisher } from "./relay/relay.publisher";
import { ResultsController } from "./results/results.controller";
import { ResultsService } from "./results/results.service";

@Module({})
export class AppModule {
  static forConfig(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        {
          module: class ConfigModule {},
          global: true,
          providers: [{ provide: APP_CONFIG, useValue: config }],
          exports: [APP_CONFIG],
        },
        DbModule,
      ],
      controllers: [CompetitionsController, JudgesController, PerformancesController, ResultsController],
      providers: [
        AuthService,
        { provide: APP_GUARD, useClass: AuthGuard },
        CompetitionsService,
        PerformancesService,
        ResultsService,
        LiveGateway,
        RelayPublisher,
      ],
    };
  }
}
