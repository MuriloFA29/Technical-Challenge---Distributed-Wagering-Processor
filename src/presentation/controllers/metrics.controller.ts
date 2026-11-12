import { Controller, Get, Header } from "@nestjs/common";
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from "@nestjs/swagger";
import { MetricsService } from "../../infrastructure/observability/metrics.service";

@ApiTags("Metrics")
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @ApiOperation({ summary: "Prometheus metrics exposition endpoint" })
  @ApiProduces("text/plain")
  @ApiResponse({ status: 200, description: "Prometheus metrics in text format", type: String })
  async getMetrics(): Promise<string> {
    return await this.metricsService.getMetrics();
  }
}
