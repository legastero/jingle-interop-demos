module.exports = function(grunt) {

  grunt.loadNpmTasks('grunt-contrib-connect')

  grunt.initConfig({
    connect: {
      server: {
        options: {
          port: 4000,
          base: '.',
          keepalive: true
        }
      }
    }
  })
}
