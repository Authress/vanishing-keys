/* eslint-disable no-console */

const { config, S3 } = require('aws-sdk');
const commander = require('commander');
const fs = require('fs-extra');
const path = require('path');
const AwsArchitect = require('aws-architect');

const REGION = 'eu-west-1';
config.update({ region: REGION });

function getVersion() {
  let release_version = '0.0';
  const pull_request = '';
  const branch = process.env.GITHUB_REF;
  const build_number = `${process.env.GITHUB_RUN_NUMBER}`;

  // Builds of pull requests
  if (pull_request && !pull_request.match(/false/i)) {
    release_version = `0.${pull_request}`;
  } else if (!branch || !branch.match(/^(refs\/heads\/)?release[/-]/i)) {
    // Builds of branches that aren't master or release
    release_version = '0.0';
  } else {
    // Builds of release branches (or locally or on server)
    release_version = branch.match(/^(?:refs\/heads\/)?release[/-](\d+(?:\.\d+){0,3})$/i)[1];
  }
  return `${release_version}.${(build_number || '0')}.0.0.0.0`.split('.').slice(0, 3).join('.');
}
const version = getVersion();
commander.version(version);

const packageMetadata = require('./package.json');
packageMetadata.version = version;

const apiOptions = {
  deploymentBucket: `${process.env.DEPLOYMENT_BUCKET}-${process.env.AWS_ACCOUNT_ID}-${REGION}`,
  sourceDirectory: path.join(__dirname, 'src'),
  description: packageMetadata.description,
  regions: [REGION]
};

/**
  * Build
  */
commander
  .command('setup')
  .description('Setup require build files for npm package.')
  .action(async () => {
    await fs.writeJson('./package.json', packageMetadata, { spaces: 2 });

    console.log('Building package %s (%s)', packageMetadata.name, version);
    console.log('');
  });

commander
  .command('deploy')
  .description('Deploys the Vanish to AWS')
  .action(async () => {
    console.log('After build package %s (%s)', packageMetadata.name, version);
    console.log('');

    try {
      const awsArchitect = new AwsArchitect(packageMetadata, apiOptions);
      await awsArchitect.publishLambdaArtifactPromise();

      const stackTemplate = require('./template/cloudformationTemplate');
      const isMainLine = process.env.GITHUB_REF === 'refs/heads/main';

      if (isMainLine) {
        const stackConfiguration = {
          changeSetName: `main-${process.env.GITHUB_RUN_NUMBER || '1'}`,
          stackName: packageMetadata.name
        };
        const parameters = {
          serviceName: packageMetadata.name,
          dnsName: 'vanish',
          hostedName: 'authress.io',
          hostedZoneId: 'Z0450507492KPW6PS5CR'
        };
        await awsArchitect.deployTemplate(stackTemplate, stackConfiguration, parameters);
      }
  
      const publicResult = await awsArchitect.publishAndDeployStagePromise({
        stage: isMainLine ? 'production' : process.env.GITHUB_REF.replace('refs/heads', ''),
        functionName: packageMetadata.name,
        deploymentKeyName: `${packageMetadata.name}/${version}/lambda.zip`
      });
  
      if (isMainLine) {
        await awsArchitect.cleanupPreviousFunctionVersions(packageMetadata.name);
      }
      console.log('Result', publicResult);
    } catch (error) {
      console.log('Failed to push new application version', error);
      process.exit(1);
    }
  });

commander
.command('run')
.description('Run lambda web service locally.')
.action(async () => {
  const awsArchitect = new AwsArchitect(packageMetadata, apiOptions);

  try {
    const logger = require('./src/logger');
    logger.logDebug = false;
    const result = await awsArchitect.Run(8080, () => { /* Do not log from server when running locally */ });
    console.log(JSON.stringify(result.title, null, 2));
  } catch (failure) {
    console.log(JSON.stringify(failure, null, 2));
  }
});

commander.command('test-setup')
.description('Test the deployment')
.action(async () => {
  try {
    const templateProvider = require('./template/cloudformationTemplate');
    const result = await new S3().listObjectsV2({ Bucket: apiOptions.deploymentBucket, StartAfter: 'document-library-microservice/0.1.1' }).promise();
    const latestLambdaVersion = result.Contents.reduce((latest, c) => !latest || c.LastModified > latest.LastModified ? c : latest, null).Key.split('/')[1];
    const template = templateProvider.getTemplate(packageMetadata.name, latestLambdaVersion);
    await fs.writeFile(path.join(__dirname, 'template/cloudformationTemplate.json'), typeof template === 'object' ? JSON.stringify(template) : template);
  } catch (error) {
    console.log('Failed to push new application version', error);
    process.exit(1);
  }
});

commander.on('*', () => {
  if (commander.args.join(' ') === 'tests/**/*.js') { return; }
  console.log(`Unknown Command: ${commander.args.join(' ')}`);
  commander.help();
  process.exit(0);
});
commander.parse(process.argv[2] ? process.argv : process.argv.concat(['build']));
