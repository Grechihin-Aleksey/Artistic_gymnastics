import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuditController } from "./audit/audit.controller";
import { AuditService } from "./audit/audit.service";
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
import { OnlineEntriesController } from "./online-entries/online-entries.controller";
import { OnlineEntriesService } from "./online-entries/online-entries.service";
import { PerformancesController } from "./performances/performances.controller";
import { PerformancesService } from "./performances/performances.service";
import { ProtocolsController } from "./protocols/protocols.controller";
import { ProtocolsService } from "./protocols/protocols.service";
import { SiteProtocolsController } from "./protocols/site-protocols.controller";
import { SiteProtocolsService } from "./protocols/site-protocols.service";
import { TransferController } from "./competitions/transfer.controller";
import { AutoExportService } from "./competitions/auto-export.service";
import { TransferService } from "./competitions/transfer.service";
import { SeriesController } from "./series/series.controller";
import { SeriesService } from "./series/series.service";
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
        AuditController,
        OnlineEntriesController,
        SiteProtocolsController,
        SeriesController,
        TransferController,
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
        AuditService,
        OnlineEntriesService,
        SiteProtocolsService,
        SeriesService,
        TransferService,
        AutoExportService,
        LiveGateway,
        RelayPublisher,
      ],
    };
  }
}
