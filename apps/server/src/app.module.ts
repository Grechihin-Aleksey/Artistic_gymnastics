import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard, AuthService } from "./auth/auth";
import { CompetitionsController } from "./competitions/competitions.controller";
import { CompetitionsService } from "./competitions/competitions.service";
import { JudgesController } from "./competitions/judges.controller";
import { RotationsController } from "./competitions/rotations.controller";
import { RotationsService } from "./competitions/rotations.service";
import { APP_CONFIG, type AppConfig } from "./config";
import { DbModule } from "./db/db.module";
import { FinalsController } from "./finals/finals.controller";
import { FinalsService } from "./finals/finals.service";
import { InquiriesController } from "./inquiries/inquiries.controller";
import { InquiriesService } from "./inquiries/inquiries.service";
import { LiveGateway } from "./live/live.gateway";
import { PerformancesController } from "./performances/performances.controller";
import { PerformancesService } from "./performances/performances.service";
import { ProtocolsController } from "./protocols/protocols.controller";
import { ProtocolsService } from "./protocols/protocols.service";
import { RelayPublisher } from "./relay/relay.publisher";
import { CeremonyController } from "./results/ceremony.controller";
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
      controllers: [
        CompetitionsController,
        JudgesController,
        RotationsController,
        PerformancesController,
        ResultsController,
        FinalsController,
        InquiriesController,
        ProtocolsController,
        CeremonyController,
      ],
      providers: [
        AuthService,
        { provide: APP_GUARD, useClass: AuthGuard },
        CompetitionsService,
        RotationsService,
        PerformancesService,
        ResultsService,
        FinalsService,
        InquiriesService,
        ProtocolsService,
        LiveGateway,
        RelayPublisher,
      ],
    };
  }
}
